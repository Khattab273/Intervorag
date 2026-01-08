const createGoogleSpeechRecognizeStream = require('./createGoogleSpeechRecognizeStream');
const createAzureSpeechRecognizeStream = require('./createAzureSpeechRecognizeStream');
const createAssemblyAIRecognizeStream = require('./createAssemblyAIRecognizeStream');
const createDeepgramRecognizeStream = require('./createDeepgramRecognizeStream');
const constants = require('../lib/constants');

/**
 * Apply post-processing to fix common phonetic confusions in transcription
 * @param {string} transcription - The original transcription
 * @param {Object} interactionSettings - Agent interaction settings
 * @returns {string} - Processed transcription with corrections
 */
function applyLexicalEnhancementPostProcessing(transcription, interactionSettings) {
  if (!interactionSettings?.lexicalEnhancement?.enabled || 
      !interactionSettings?.lexicalEnhancement?.terms?.length) {
    return transcription;
  }

  let processedText = transcription;

  // Apply corrections for each lexical enhancement term
  interactionSettings.lexicalEnhancement.terms.forEach(term => {
    if (!term.word) return;

    const targetWord = term.word.toLowerCase();
    
    // Create a list of common phonetic confusions for this word
    const phoneticConfusions = generatePhoneticConfusions(targetWord, term.pronunciation);
    
    // Replace each confusion with the correct word (case-insensitive, word boundaries)
    phoneticConfusions.forEach(confusion => {
      const regex = new RegExp(`\\b${escapeRegex(confusion)}\\b`, 'gi');
      processedText = processedText.replace(regex, (match) => {
        // Preserve the original case pattern
        return preserveCase(match, term.word);
      });
    });
  });

  return processedText;
}

/**
 * Generate common phonetic confusions for a target word
 */
function generatePhoneticConfusions(targetWord, pronunciation) {
  const confusions = [];
  
  // Common patterns for business/tech names that get confused
  const phoneticMappings = [
    // For words that start with "inter"
    { pattern: /^inter.{0,3}$/i, confusions: ['interval', 'into', 'inter', 'intro'] },
    // For words ending in common sounds
    { pattern: /vo$/i, confusions: ['val', 'vol', 'view'] },
    { pattern: /tech$/i, confusions: ['take', 'tech', 'check'] },
    { pattern: /ai$/i, confusions: ['eye', 'ay', 'high'] },
    // Add more patterns as needed
  ];

  phoneticMappings.forEach(({ pattern, confusions: mappingConfusions }) => {
    if (pattern.test(targetWord)) {
      confusions.push(...mappingConfusions);
    }
  });

  // If we have a pronunciation, also check for direct phonetic variations
  if (pronunciation) {
    const phoneticLower = pronunciation.toLowerCase();
    
    // Add variations based on common speech recognition errors
    if (phoneticLower.includes('inter')) {
      confusions.push('interval', 'into the', 'under');
    }
    
    // Add separator variations
    if (phoneticLower.includes('-') || phoneticLower.includes(' ')) {
      const parts = phoneticLower.split(/[-\s]+/);
      if (parts.length === 2) {
        // Common misrecognitions for two-part pronunciations
        confusions.push(parts.join(''), parts[0], `${parts[0]} ${parts[1]}`);
      }
    }
  }

  // Remove duplicates and the target word itself
  return [...new Set(confusions)].filter(c => c.toLowerCase() !== targetWord);
}

/**
 * Escape special regex characters
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Preserve the case pattern of the original word when replacing
 */
function preserveCase(originalWord, replacementWord) {
  // If original is all uppercase, return uppercase replacement
  if (originalWord === originalWord.toUpperCase()) {
    return replacementWord.toUpperCase();
  }
  
  // If original starts with uppercase, capitalize replacement
  if (originalWord[0] === originalWord[0].toUpperCase()) {
    return replacementWord.charAt(0).toUpperCase() + replacementWord.slice(1).toLowerCase();
  }
  
  // Otherwise return lowercase replacement
  return replacementWord.toLowerCase();
}
// Note: The create functions (Google, Azure, AssemblyAI) now need to be async
// because AssemblyAI's setup involves an async connect() call.
// The calling code in twilioHandler already uses await when creating the stream,
// so this change should be compatible.
async function createSpeechRecognizeStream(config, params) {


  /*common logic here */
  const {interactionSettings} = config.agent;
  const responseThreshold = interactionSettings?.responseThreshold || 0.5;
  const { STT_ENDPOINTING_HIGH_MS, STT_ENDPOINTING_LOW_MS } = constants;

  const endPointingMs = STT_ENDPOINTING_LOW_MS + (STT_ENDPOINTING_HIGH_MS - STT_ENDPOINTING_LOW_MS) * responseThreshold;


    console.log("Selecting STT Service:", config.sttService?.toLowerCase());
  switch (config.sttService?.toLowerCase()) {
    case 'azure speech services':
      // Assuming createAzureSpeechRecognizeStream is also async or returns a promise
      return await createAzureSpeechRecognizeStream({...params, endPointingMs, agentConfig: config.agent, applyLexicalEnhancementPostProcessing});
    case 'assembly ai':
    case 'assemblyai': // Add alias for flexibility
      // createAssemblyAIRecognizeStream is now async
      return await createAssemblyAIRecognizeStream({...params, endPointingMs, agentConfig: config.agent, applyLexicalEnhancementPostProcessing});
    case 'deepgram':
      return await createDeepgramRecognizeStream({...params, endPointingMs, agentConfig: config.agent, applyLexicalEnhancementPostProcessing});
    case 'google':
    default:
      console.log("Defaulting to Google STT Service");
      // Assuming createGoogleSpeechRecognizeStream is NOT async, but awaiting it is safe.
      return await createGoogleSpeechRecognizeStream({...params, endPointingMs, agentConfig: config.agent, applyLexicalEnhancementPostProcessing});
  }
}

module.exports = createSpeechRecognizeStream;
