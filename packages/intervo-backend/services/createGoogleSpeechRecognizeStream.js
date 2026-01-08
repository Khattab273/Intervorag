const speech = require("@google-cloud/speech");
const path = require('path');
process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(
  process.cwd(),
  process.env.GOOGLE_CREDENTIALS_DIR,
  process.env.GOOGLE_CREDENTIALS_FILENAME
);
const client = new speech.SpeechClient({});

function createGoogleSpeechRecognizeStream({ 
  timer, 
  ws, 
  wss, 
  agentRoomBroker, // The agent rooms broker for room-specific broadcasting
  ignoreNewTranscriptions, 
  isProcessingTTS, 
  processTranscription, 
  resetInactivityTimeout, 
  inactivityTimeout,
  userInterrupted,
  agentConfig={},
  applyLexicalEnhancementPostProcessing
}) {
  const {interactionSettings} = agentConfig;

  // Build speech contexts with default phrases and lexical enhancement terms
  const defaultPhrases = [
    "CodeDesign",
    "CodeDesign.ai",
    "Intervo.ai",
    "Intervo",
    "Manjunath",
    "Hey",
    "hai",
  ];

  // Add lexical enhancement terms if available and enabled
  const lexicalPhrases = [];
  const highBoostPhrases = [];
  
  if (interactionSettings?.lexicalEnhancement?.enabled && 
      interactionSettings?.lexicalEnhancement?.terms?.length > 0) {
    interactionSettings.lexicalEnhancement.terms.forEach(term => {
      if (term.word) {
        // Add the main word with high boost to prioritize it
        highBoostPhrases.push(term.word);
        
        // Add pronunciation variants if different from the word
        if (term.pronunciation && term.pronunciation !== term.word) {
          highBoostPhrases.push(term.pronunciation);
          
          // Generate common pronunciation variants for any pronunciation with separators
          const phonetic = term.pronunciation.toLowerCase();
          
          // Add variants with different separators (hyphens, spaces, no separator)
          if (phonetic.includes('-')) {
            lexicalPhrases.push(phonetic.replace(/-/g, ' ')); // Replace hyphens with spaces
            lexicalPhrases.push(phonetic.replace(/-/g, '')); // Remove hyphens entirely
          }
          
          // Add variants for other common separators
          if (phonetic.includes('_')) {
            lexicalPhrases.push(phonetic.replace(/_/g, ' ')); // Replace underscores with spaces
            lexicalPhrases.push(phonetic.replace(/_/g, '')); // Remove underscores entirely
          }
          
          if (phonetic.includes('.')) {
            lexicalPhrases.push(phonetic.replace(/\./g, ' ')); // Replace dots with spaces
            lexicalPhrases.push(phonetic.replace(/\./g, '')); // Remove dots entirely
          }
        }
        
        // Add company/brand context phrases to strengthen recognition for any term
        lexicalPhrases.push(term.word + " ai");
        lexicalPhrases.push(term.word + " dot ai");
        lexicalPhrases.push(term.word + " platform");
        lexicalPhrases.push(term.word + " system");
        lexicalPhrases.push(term.word + " service");
        lexicalPhrases.push(term.word + " app");
        lexicalPhrases.push(term.word + " software");
      }
    });
  }

  const allPhrases = [...defaultPhrases, ...lexicalPhrases];

  const request = {
    config: {
      encoding: "MULAW",
      sampleRateHertz: 8000,
      languageCode: "en-US",
      enableAutomaticPunctuation: false,
      useEnhanced: true,
      model: "phone_call",
    },
    interimResults: true,

    // Use advanced model adaptation instead of basic speechContexts
    adaptation: highBoostPhrases.length > 0 ? {
      phraseSets: [{
        phrases: [
          ...highBoostPhrases.map(phrase => ({ value: phrase, boost: 20 })),
          ...lexicalPhrases.map(phrase => ({ value: phrase, boost: 15 }))
        ]
      }]
    } : undefined,

    // Fallback to speechContexts for compatibility
    speechContexts: highBoostPhrases.length === 0 ? [{
      phrases: allPhrases,
      boost: 15
    }] : [],
  };
  
  console.log("Creating recognize stream");

  const recognizeStream = client.streamingRecognize(request)
    .on("data", async (data) => {

      if (data.results[0] && data.results[0].alternatives[0]) {
        const transcription = data.results[0].alternatives[0].transcript;
        const isFinal = data.results[0].isFinal;

        // Skip empty transcriptions
        if (!transcription.trim()) return;

        // If this is an interim result and we're currently processing TTS, set interruption flag
        if (!isFinal && transcription.trim()) {
          console.log(`[${timer()}] User interruption detected during TTS: ${transcription}`);
          userInterrupted.value = true;
          return; // Don't process interim results further
        }

        // Only process final results for actual transcription
        if (!isFinal) {
          return; // Skip interim results for transcription processing
        }

        if (ignoreNewTranscriptions || isProcessingTTS) return;

        console.log(`[${timer()}] Transcription received: ${transcription}`);
        
        // Apply lexical enhancement post-processing to fix common confusions
        const processedTranscription = applyLexicalEnhancementPostProcessing ? 
          applyLexicalEnhancementPostProcessing(transcription, interactionSettings) : 
          transcription;
        
        // Send transcription to room-specific clients only
        if (ws.roomKey && agentRoomBroker) {
          await agentRoomBroker.broadcast(ws.roomKey, { event: "transcription", source:"user", text: processedTranscription }, { exclude: ws });
        }

        clearTimeout(inactivityTimeout);
        await processTranscription(processedTranscription);
      }
    })
    .on("error", (error) => {
      console.error(`[${timer()}] Google Speech-to-Text error:`, error);
    })
    .on("end", () => {
      console.log(`[${timer()}] Google Speech-to-Text streaming ended.`);
      if (!isProcessingTTS) {
        console.log(`[${timer()}] Restarting transcription stream after end`);
        return createGoogleSpeechRecognizeStream({ 
          timer, 
          ws, 
          wss, 
          agentRoomBroker,
          ignoreNewTranscriptions, 
          isProcessingTTS, 
          processTranscription, 
          resetInactivityTimeout, 
          inactivityTimeout,
          userInterrupted,
          agentConfig,
          applyLexicalEnhancementPostProcessing
        });
      }
    });

  return recognizeStream;
}



module.exports = createGoogleSpeechRecognizeStream;
