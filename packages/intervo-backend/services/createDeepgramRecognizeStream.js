const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

async function createDeepgramRecognizeStream({ 
  timer, 
  ws, 
  wss, 
  agentRoomBroker, // The agent rooms broker for room-specific broadcasting
  ignoreNewTranscriptions, 
  isProcessingTTS, 
  processTranscription, 
  resetInactivityTimeout, // Keep for consistency, though Deepgram endpointing handles silence
  inactivityTimeout,
  endPointingMs,
  userInterrupted,
  agentConfig={},
  applyLexicalEnhancementPostProcessing
}) {
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY;

  if (!deepgramApiKey) {
    console.error(`[${timer()}] Deepgram API Key not found. Please set DEEPGRAM_API_KEY environment variable.`);
    return { // Return dummy object
      write: () => {},
      end: () => { console.log(`[${timer()}] Deepgram stream ended (no API key).`); },
      pause: () => {},
      resume: () => {}
    };
  }

  const deepgramClient = createClient(deepgramApiKey);
  let connection = null;
  let isPaused = false;
  let isReady = false; // Flag to ensure connection is open before writing

  try {
    // Build keywords for Deepgram's keyword boosting
    const keywords = [];
    
    // Add default keywords
    keywords.push("CodeDesign:1", "Intervo:1");
    
    // Add lexical enhancement terms if available and enabled
    if (agentConfig?.interactionSettings?.lexicalEnhancement?.enabled && 
        agentConfig?.interactionSettings?.lexicalEnhancement?.terms?.length > 0) {
      agentConfig.interactionSettings.lexicalEnhancement.terms.forEach(term => {
        if (term.word) {
          keywords.push(`${term.word}:1`);
          // Also add pronunciation as a keyword if it's different from the word
          if (term.pronunciation && term.pronunciation !== term.word) {
            keywords.push(`${term.pronunciation}:1`);
            
            // Add common pronunciation variants
            const pronunciation = term.pronunciation.toLowerCase();
            if (pronunciation.includes('-')) {
              keywords.push(`${pronunciation.replace(/-/g, ' ')}:1`);
              keywords.push(`${pronunciation.replace(/-/g, '')}:1`);
            }
          }
        }
      });
    }

    connection = deepgramClient.listen.live({
      model: "nova-2-phonecall", // Model optimized for telephony
      language: "en-US",
      encoding: "mulaw", 
      sample_rate: 8000, 
      punctuate: true,
      interim_results: true, // Enable interim results for interruption detection
      endpointing: endPointingMs, // Milliseconds of silence to detect end of utterance (adjust as needed)
      keywords: keywords.length > 0 ? keywords : undefined, // Add keywords for boosting if available
    });

    connection.on(LiveTranscriptionEvents.Open, () => {
      // console.log(`[${timer()}] Deepgram connection opened.`);
      isReady = true;
    });

    connection.on(LiveTranscriptionEvents.Transcript, async (data) => {
      // console.log(`[${timer()}] Deepgram Transcript received:`, JSON.stringify(data, null, 2));
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      
      // Handle interim results for interruption detection
      if (transcript && !data.is_final) {
        // If this is an interim result and we're currently processing TTS, set interruption flag
        if ( transcript.trim()) {
          console.log(`[${timer()}] User interruption detected during TTS: ${transcript}`);
          if (userInterrupted) {
            userInterrupted.value = true;
          }
          return; // Don't process interim results further
        }
        return; // Skip other interim processing
      }
      
      // We configured interim_results: false, but double-check is_final
      if (transcript && data.is_final) {
        if (ignoreNewTranscriptions || isProcessingTTS || isPaused) {
          console.log(`[${timer()}] Ignoring Deepgram transcript (processing, TTS, or paused)`);
          return;
        }
        
        // Apply lexical enhancement post-processing to fix common confusions
        const processedTranscription = applyLexicalEnhancementPostProcessing ? 
          applyLexicalEnhancementPostProcessing(transcript, agentConfig?.interactionSettings) : 
          transcript;
        
        // Send processed transcription to room-specific clients only
        if (ws.roomKey && agentRoomBroker) {
          await agentRoomBroker.broadcast(ws.roomKey, { event: "transcription", source: "user", text: processedTranscription }, { exclude: ws });
        }

        clearTimeout(inactivityTimeout); // Clear timer on final result
        await processTranscription(processedTranscription);
      } else if (!data.is_final && transcript) {
          // console.log(`[${timer()}] Deepgram Interim: "${transcript}"`);
          // Handle interim if needed in the future, e.g., for UI
          // resetInactivityTimeout(transcript); // Maybe reset timeout on interim?
      }
    });

    connection.on(LiveTranscriptionEvents.UtteranceEnd, (data) => {
       console.log(`[${timer()}] Deepgram UtteranceEnd received.`);
       // This event might be useful if endpointing alone isn't sufficient,
       // potentially triggering processTranscription if no final transcript arrived shortly after.
    });

    connection.on(LiveTranscriptionEvents.Error, (error) => {
      console.error(`[${timer()}] Deepgram connection error:`);
      isReady = false; // Mark as not ready on error
      // Potentially attempt reconnection or notify handler
    });

    connection.on(LiveTranscriptionEvents.Close, (event) => {
      console.log(`[${timer()}] Deepgram connection closed:`);
      isReady = false; // Mark as not ready on close
    });
    
    // Return the interface object immediately 
    // `isReady` flag handles writes before 'open' fires
    return {
      write: (base64Chunk) => {
        if (!isReady) {
          // console.warn(`[${timer()}] Deepgram write called before connection is ready.`);
          return; // Don't send if not ready
        }
        if (isPaused) {
          // console.log(`[${timer()}] Deepgram stream paused, ignoring write.`);
          return;
        }
        if (connection) {
          try {
            // Deepgram expects raw audio buffer, not base64
            const rawAudio = Buffer.from(base64Chunk, 'base64');
            connection.send(rawAudio);
          } catch (error) {
            console.error(`[${timer()}] Error decoding or sending audio chunk to Deepgram:`);
          }
        } else {
             console.error(`[${timer()}] Deepgram write called, but connection is null.`);
        }
      },
      end: () => {
        console.log(`[${timer()}] Ending Deepgram stream.`);
        isReady = false;
        if (connection) {
           try {
               // Finish the connection gracefully
               connection.finish();
               console.log(`[${timer()}] Deepgram connection finish() called.`);
           } catch (error) {
               console.error(`[${timer()}] Error calling Deepgram connection.finish():`);
           }
           connection = null; 
        }
      },
      pause: () => {
        console.log(`[${timer()}] --- Deepgram Stream Paused ---`);
        isPaused = true;
      },
      resume: () => {
        console.log(`[${timer()}] --- Deepgram Stream Resumed ---`);
        isPaused = false;
      }
    };

  } catch (error) {
    console.error(`[${timer()}] Error setting up Deepgram connection:`);
     // Return dummy object on setup error
    return {
      write: () => {},
      end: () => { console.log(`[${timer()}] Deepgram stream ended (setup error).`); },
      pause: () => {},
      resume: () => {}
    };
  }
}

module.exports = createDeepgramRecognizeStream;
