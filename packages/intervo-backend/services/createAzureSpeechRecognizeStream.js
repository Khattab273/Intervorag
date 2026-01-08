const sdk = require("microsoft-cognitiveservices-speech-sdk");
const { Transform } = require('stream');

function mulawToPcm(mulawData) {
  // µ-law to linear PCM conversion table
  const MULAW_DECODE_TABLE = new Int16Array([
    -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
    -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
    -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
    -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
    -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
    -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
    -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
    -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
    -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
    -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
    -876, -844, -812, -780, -748, -716, -684, -652,
    -620, -588, -556, -524, -492, -460, -428, -396,
    -372, -356, -340, -324, -308, -292, -276, -260,
    -244, -228, -212, -196, -180, -164, -148, -132,
    -120, -112, -104, -96, -88, -80, -72, -64,
    -56, -48, -40, -32, -24, -16, -8, 0,
    32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
    23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
    15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
    11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
    7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
    5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
    3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
    2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
    1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
    1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
    876, 844, 812, 780, 748, 716, 684, 652,
    620, 588, 556, 524, 492, 460, 428, 396,
    372, 356, 340, 324, 308, 292, 276, 260,
    244, 228, 212, 196, 180, 164, 148, 132,
    120, 112, 104, 96, 88, 80, 72, 64,
    56, 48, 40, 32, 24, 16, 8, 0
  ]);

  const pcmData = new Int16Array(mulawData.length);
  
  for (let i = 0; i < mulawData.length; i++) {
    const index = Math.max(0, Math.min(255, mulawData[i]));
    pcmData[i] = MULAW_DECODE_TABLE[index];
  }
  
  return Buffer.from(pcmData.buffer);
}

async function createAzureSpeechRecognizeStream({ 
  timer, 
  ws, 
  wss, 
  agentRoomBroker, // The agent rooms broker for room-specific broadcasting
  ignoreNewTranscriptions, 
  isProcessingTTS, 
  processTranscription, 
  resetInactivityTimeout, 
  inactivityTimeout, 
  endPointingMs,
  userInterrupted,
  agentConfig={},
  applyLexicalEnhancementPostProcessing
}) {

  console.log("azure speech recognize stream");
  const azureKey = process.env.AZURE_SPEECH_KEY;
  const azureRegion = process.env.AZURE_SPEECH_REGION;

  if (!azureKey || !azureRegion) {
    console.error(`[${timer()}] Azure Speech Key or Region not found. Please set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION environment variables.`);
    // Return a dummy stream object
    return {
      write: () => {},
      end: () => { console.log(`[${timer()}] Azure stream ended (no credentials).`); },
      pause: () => {},
      resume: () => {}
    };
  }

  let audioInputStream = null;
  let recognizer = null;
  let isPaused = false;
  let isReady = false;

  // Wrap setup in a Promise
  return new Promise((resolve, reject) => {
    try {
      // Configure speech config
      const speechConfig = sdk.SpeechConfig.fromSubscription(azureKey, azureRegion);
      speechConfig.speechRecognitionLanguage = "en-US";
      
      // Enable interim results for interruption detection (equivalent to Google's interimResults: true)
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_EnableAudioLogging, "false");
      speechConfig.requestWordLevelTimestamps = true;
      
      // Set segmentation silence timeout if provided
      const silenceTimeout = endPointingMs !== undefined ? endPointingMs : 800;
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_SegmentationSilenceTimeoutMs, String(silenceTimeout));
      console.log(`[${timer()}] Azure segmentationSilenceTimeoutMs set to: ${silenceTimeout}`);

      // Create audio format: 8kHz sample rate, 16 bits per sample, 1 channel (PCM)
      const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1);
      audioInputStream = sdk.AudioInputStream.createPushStream(audioFormat);
      const audioConfig = sdk.AudioConfig.fromStreamInput(audioInputStream);

      // Create the recognizer
      recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      // --- Dynamic Phrase list boosting with lexical enhancement --- 
      const phraseList = sdk.PhraseListGrammar.fromRecognizer(recognizer);
      
      // Add default phrases
      phraseList.addPhrase("CodeDesign");
      phraseList.addPhrase("CodeDesign.ai");
      phraseList.addPhrase("Intervo");
      phraseList.addPhrase("Intervo.ai");
      
      // Add lexical enhancement terms if available and enabled
      if (agentConfig?.interactionSettings?.lexicalEnhancement?.enabled && 
          agentConfig?.interactionSettings?.lexicalEnhancement?.terms?.length > 0) {
        agentConfig.interactionSettings.lexicalEnhancement.terms.forEach(term => {
          if (term.word) {
            phraseList.addPhrase(term.word);
            // Also add pronunciation as an alternative if it's different from the word
            if (term.pronunciation && term.pronunciation !== term.word) {
              phraseList.addPhrase(term.pronunciation);
              
              // Add common pronunciation variants
              const pronunciation = term.pronunciation.toLowerCase();
              if (pronunciation.includes('-')) {
                phraseList.addPhrase(pronunciation.replace(/-/g, ' '));
                phraseList.addPhrase(pronunciation.replace(/-/g, ''));
              }
            }
          }
        });
      }
      // --- End Phrase list --- 

      // --- Event Handlers --- 

      // Handle final recognition results
      recognizer.recognized = async (s, e) => {
        console.log(`[${timer()}] Azure RECOGNIZED: ResultReason=${sdk.ResultReason[e.result.reason]} Text="${e.result.text}"`);
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
          if (isProcessingTTS || isPaused) {
            console.log(`[${timer()}] Ignoring Azure transcript (TTS or paused)`);
            return;
          }
          const transcription = e.result.text;
          
          // Apply lexical enhancement post-processing to fix common confusions
          const processedTranscription = applyLexicalEnhancementPostProcessing ? 
            applyLexicalEnhancementPostProcessing(transcription, agentConfig?.interactionSettings) : 
            transcription;
          
          // Send processed transcription to room-specific clients only
          if (ws.roomKey && agentRoomBroker) {
            await agentRoomBroker.broadcast(ws.roomKey, { event: "transcription", source: "user", text: processedTranscription }, { exclude: ws });
          }

          clearTimeout(inactivityTimeout); // Clear timer on final result
          await processTranscription(processedTranscription);
        } else if (e.result.reason === sdk.ResultReason.NoMatch) {
          console.log(`[${timer()}] Azure NOMATCH: Speech could not be recognized.`);
        }
      };

      // Handle interim results for interruption detection (equivalent to Google's interim results)
      recognizer.recognizing = (s, e) => {
        console.log(`[${timer()}] Azure RECOGNIZING: Text="${e.result.text}"`);
        
        // Skip empty transcriptions
        if (!e.result.text || !e.result.text.trim()) return;
        
        // If we're currently processing TTS, set interruption flag
        if (e.result.text.trim()) {
          console.log(`[${timer()}] User interruption detected during TTS: ${e.result.text}`);
          if (userInterrupted) {
            userInterrupted.value = true;
          }
          return; // Don't process interim results further
        }
        
        // For debugging - log interim results but don't process them
        console.log(`[${timer()}] Azure interim result: "${e.result.text}"`);
      };

      // Handle cancellation
      recognizer.canceled = (s, e) => {
        console.error(`[${timer()}] Azure CANCELED: Reason=${sdk.CancellationReason[e.reason]}`);
        if (e.reason === sdk.CancellationReason.Error) {
          console.error(`[${timer()}] Azure CANCELED: ErrorCode=${e.errorCode}`);
          console.error(`[${timer()}] Azure CANCELED: ErrorDetails=${e.errorDetails}`);
          console.error(`[${timer()}] Azure CANCELED: Did you set the speech resource key and region values?`);
        }
        // Reject the promise if cancellation happens before ready
        if (!isReady) {
          reject(new Error(`Azure recognition canceled: ${e.errorDetails}`));
        }
        // Consider stopping permanently or attempting re-connection if needed
      };

      // Handle session events (start/stop)
      recognizer.sessionStarted = (s, e) => {
        console.log(`[${timer()}] Azure Session started: ${e.sessionId}`);
      };

      recognizer.sessionStopped = (s, e) => {
        console.log(`[${timer()}] Azure Session stopped: ${e.sessionId}`);
        // Recognition might stop unexpectedly, might need cleanup or restart logic here
         isReady = false; // Mark as not ready if session stops
      };
      
      // --- Start Recognition and Resolve Promise --- 
      recognizer.startContinuousRecognitionAsync(
        () => { // On success
          console.log(`[${timer()}] Azure continuous recognition started successfully.`);
          isReady = true;
          // Resolve with the stream interface object
          resolve({
            write: (base64Chunk) => {
              if (!isReady) {
                console.warn(`[${timer()}] Azure write called before recognizer is ready.`);
                return;
              }
              if (isPaused) {
                // console.log(`[${timer()}] Azure stream paused, ignoring write.`);
                return;
              }
              if (audioInputStream) {
                try {
                  const rawAudio = Buffer.from(base64Chunk, 'base64');
                  const pcmAudio = mulawToPcm(rawAudio);
                  // console.log(`[${timer()}] Writing ${pcmAudio.length} PCM bytes to Azure stream`);
                  audioInputStream.write(pcmAudio);
                } catch (error) {
                  console.error(`[${timer()}] Error processing or writing audio chunk to Azure:`, error);
                }
              } else {
                  console.error(`[${timer()}] Azure write called, but audioInputStream is null.`);
              }
            },
            end: () => {
              console.log(`[${timer()}] Ending Azure stream.`);
              isReady = false;
              if (recognizer) {
                recognizer.stopContinuousRecognitionAsync(
                  () => { console.log(`[${timer()}] Azure recognizer stopped.`); },
                  (err) => { console.error(`[${timer()}] Azure recognizer stop error:`, err); }
                );
                // It's good practice to close the recognizer and free resources
                // recognizer.close(); // May cause issues if called too soon after stop
                 recognizer = null; 
              }
              if (audioInputStream) {
                audioInputStream.close();
                audioInputStream = null;
              }
            },
            pause: () => {
              console.log(`[${timer()}] --- Azure Stream Paused ---`);
              isPaused = true;
            },
            resume: () => {
              console.log(`[${timer()}] --- Azure Stream Resumed ---`);
              isPaused = false;
            }
          });
        },
        (err) => { // On failure
          console.error(`[${timer()}] Azure startContinuousRecognitionAsync failed: ${err}`);
          // Clean up partial resources if start fails
           if (audioInputStream) { audioInputStream.close(); audioInputStream = null; }
           if (recognizer) { /* recognizer.close(); */ recognizer = null; } // SDK might auto-cleanup?
          reject(new Error(`Azure recognition failed to start: ${err}`));
        }
      );

    } catch (error) {
      console.error(`[${timer()}] Error setting up Azure speech recognition:`, error);
       if (audioInputStream) { audioInputStream.close(); audioInputStream = null; }
       if (recognizer) { /* recognizer.close(); */ recognizer = null; } 
      reject(error);
    }
  }); // End of Promise constructor
}

module.exports = createAzureSpeechRecognizeStream; 
