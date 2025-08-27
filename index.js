const { Anthropic } = require('@anthropic-ai/sdk');
const { documents } = require('./documents');
const fs = require('fs').promises;
const path = require('path');

// Initialize Anthropic client with beta headers for Files API
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    'anthropic-beta': 'files-api-2025-04-14'
  }
});

// Telegram Bot Token from environment
const BOT_TOKEN = process.env.VaccibotToken;

// Load system prompt and start message
let systemPrompt = '';
let startMessage = '';

async function loadTextFiles() {
  try {
    systemPrompt = await fs.readFile(path.join(__dirname, 'SystemPrompt.txt'), 'utf-8');
    console.log('System prompt loaded successfully');
  } catch (error) {
    console.error('Error loading system prompt:', error);
    systemPrompt = 'You are a helpful medical information assistant that provides evidence-based information about vaccines and infections.';
  }

  try {
    startMessage = await fs.readFile(path.join(__dirname, 'StartMessage.txt'), 'utf-8');
    console.log('Start message loaded successfully');
  } catch (error) {
    console.error('Error loading start message:', error);
    startMessage = 'Напишите свой вопрос об инфекциях и вакцинах. Отвечу строго на основании памяток АНО "Коллективный иммунитет" и конспектов гайдлайнов Подтемы.';
  }
}

// Load text files on cold start
loadTextFiles();

/**
 * Main webhook handler for Telegram updates
 */
exports.telegramWebhook = async (req, res) => {
  try {
    // Parse Telegram update
    const update = req.body;
    
    if (!update.message) {
      console.log('Received update without message');
      return res.status(200).send('OK');
    }

    const chatId = update.message.chat.id;
    const userId = update.message.from?.id;
    const username = update.message.from?.username || 'unknown';
    const firstName = update.message.from?.first_name || '';
    
    console.log(`User ${userId} (@${username}): Received message in chat ${chatId}`);
    
    if (!update.message.text) {
      console.log(`User ${userId}: Non-text message received, ignoring`);
      return res.status(200).send('OK');
    }

    const userMessage = update.message.text;
    console.log(`User ${userId}: Message: "${userMessage.substring(0, 100)}${userMessage.length > 100 ? '...' : ''}"`);

    // Check for /start command
    if (userMessage.startsWith('/start')) {
      console.log(`User ${userId}: Handling /start command`);
      const startParams = userMessage.replace('/start', '').trim();
      if (startParams) {
        console.log(`User ${userId}: Start parameters: "${startParams}"`);
      }
      
      // Send start message
      await sendTelegramMessage(chatId, startMessage);
      console.log(`User ${userId}: Start message sent`);
      return res.status(200).send('OK');
    }

    // Send typing action
    await sendTypingAction(chatId);

    // Call Anthropic API with citations
    console.log(`User ${userId}: Calling Anthropic API with ${documents.length} documents...`);
    const response = await getAnthropicResponse(userMessage, userId);

    // Process and format response with citations
    const { mainMessage, citationsMessage } = formatResponseWithCitations(response, userId);
    const mainLength = mainMessage.length;
    const citationsLength = citationsMessage ? citationsMessage.length : 0;
    
    console.log(`User ${userId}: Main response ready (${mainLength} chars)`);
    if (citationsMessage) {
      console.log(`User ${userId}: Citations message ready (${citationsLength} chars)`);
    }

    // Send main message
    if (mainLength > 4096) {
      console.warn(`User ${userId}: Main message too long (${mainLength} chars), truncating...`);
      const truncated = mainMessage.substring(0, 4000) + '\n\n<i>[Сообщение было сокращено из-за ограничений Telegram]</i>';
      await sendTelegramMessage(chatId, truncated, userId);
    } else {
      await sendTelegramMessage(chatId, mainMessage, userId);
    }
    
    // Send citations as a separate message if they exist
    if (citationsMessage) {
      console.log(`User ${userId}: Sending citations as separate message`);
      await sendTelegramMessage(chatId, citationsMessage, userId);
    }
    
    console.log(`User ${userId}: All messages sent successfully`);
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('Error processing webhook:', error.message);
    console.error('Error details:', error.response?.data || error.stack);
    
    // Try to send error message to user
    if (req.body?.message?.chat?.id) {
      const userId = req.body.message.from?.id || 'unknown';
      console.log(`User ${userId}: Sending error message`);
      
      try {
        await sendTelegramMessage(
          req.body.message.chat.id, 
          'Извините, произошла ошибка при обработке вашего запроса. Пожалуйста, попробуйте еще раз.',
          userId
        );
      } catch (sendError) {
        console.error(`User ${userId}: Failed to send error message:`, sendError.message);
      }
    }
    
    res.status(200).send('OK'); // Always return 200 to prevent Telegram retries
  }
};

/**
 * Call Anthropic API with all documents and citations enabled
 */
async function getAnthropicResponse(userMessage, userId) {
  try {
    // Prepare content blocks
    const contentBlocks = [];
    
    // Add document blocks WITH CITATIONS ENABLED
    documents.forEach((doc, index) => {
      contentBlocks.push({
        type: 'document',
        source: {
          type: 'file',
          file_id: doc.fileId
        },
        title: doc.title,  // Add document title
        citations: { enabled: true }  // CRITICAL: Enable citations!
      });
    });
    
    // Add user's question
    contentBlocks.push({
      type: 'text',
      text: userMessage
    });

    console.log(`User ${userId}: Sending request with ${documents.length} documents (citations enabled)`);
    
    // Log the request structure for debugging
    console.log(`User ${userId}: Request structure:`, JSON.stringify({
      documentsCount: documents.length,
      firstDoc: contentBlocks[0],
      lastBlock: contentBlocks[contentBlocks.length - 1]
    }, null, 2));

    const startTime = Date.now();
    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: contentBlocks
        }
      ]
    });
    
    const apiTime = Date.now() - startTime;
    console.log(`User ${userId}: API response received in ${apiTime}ms`);
    
    // Log complete raw response for debugging
    console.log(`User ${userId}: Complete raw response:`, JSON.stringify(response, null, 2));
    
    // Log token usage
    if (response.usage) {
      console.log(`User ${userId}: Tokens - Input: ${response.usage.input_tokens}, Output: ${response.usage.output_tokens}`);
    }

    return response;
    
  } catch (error) {
    console.error(`User ${userId}: Anthropic API error:`, error.message);
    if (error.response?.data) {
      console.error(`User ${userId}: API error details:`, JSON.stringify(error.response.data));
    }
    throw error;
  }
}

/**
 * Convert markdown bold and italics to HTML tags
 */
function processMarkdown(text) {
  // Process bold (**text** or __text__)
  text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^_]+)__/g, '<b>$1</b>');
  
  // Process italics (*text* or _text_)
  // Be careful not to match already processed bold markers
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>');
  text = text.replace(/(?<!_)_([^_]+)_(?!_)/g, '<i>$1</i>');
  
  return text;
}

/**
 * Format Anthropic response with citation superscripts and return separate messages
 */
function formatResponseWithCitations(response, userId) {
  let fullText = '';
  const citations = []; // Array to store citation details
  let citationCounter = 1;
  let totalCitations = 0;
  
  console.log(`User ${userId}: Processing ${response.content.length} content blocks`);
  
  // Process each content block
  for (let i = 0; i < response.content.length; i++) {
    const block = response.content[i];
    console.log(`User ${userId}: Block ${i} type: ${block.type}, has citations: ${!!(block.citations && block.citations.length > 0)}`);
    
    if (block.type === 'text') {
      let text = block.text;
      
      // Process markdown to HTML (before adding citations)
      text = processMarkdown(text);
      
      // If block has citations, add superscript numbers
      if (block.citations && block.citations.length > 0) {
        console.log(`User ${userId}: Block ${i} has ${block.citations.length} citations`);
        totalCitations += block.citations.length;
        const citationNumbers = [];
        
        for (const citation of block.citations) {
          console.log(`User ${userId}: Processing citation:`, JSON.stringify(citation, null, 2));
          
          const docIndex = citation.document_index;
          const doc = documents[docIndex];
          
          if (doc) {
            console.log(`User ${userId}: Found document at index ${docIndex}: ${doc.title}`);
            
            // Store citation details including the full text - FIX: use cited_text
            citations.push({
              number: citationCounter,
              text: citation.cited_text || 'Текст цитаты не найден', // Changed from citation.text to citation.cited_text
              title: citation.document_title || doc.title,
              url: doc.url
            });
            
            citationNumbers.push(citationCounter);
            citationCounter++;
          } else {
            console.warn(`User ${userId}: Document not found at index ${docIndex}`);
          }
        }
        
        // Add bracket citations to text
        if (citationNumbers.length > 0) {
          const citationLinks = citationNumbers
            .map(num => {
              const citation = citations.find(c => c.number === num);
              return `<a href="${citation.url}"><b>[${num}]</b></a>`;
            })
            .join('');
          console.log(`User ${userId}: Adding citations: ${citationLinks}`);
          text = text + citationLinks;
        }
      }
      
      fullText += text;
    }
  }
  
  console.log(`User ${userId}: Found ${totalCitations} citations from ${citations.length} unique sources`);
  
  // Escape HTML entities in the main text (but preserve our tags and processed markdown)
  fullText = escapeHtml(fullText);
  
  // Create citations message if there are citations
  let citationsMessage = null;
  if (citations.length > 0) {
    citationsMessage = formatCitationsMessage(citations, userId);
  }
  
  return {
    mainMessage: fullText,
    citationsMessage: citationsMessage
  };
}

/**
 * Sanitize text for safe inclusion in HTML - removes ALL problematic characters
 */
function sanitizeForBlockquote(text) {
  // Remove all newlines, carriage returns, tabs - replace with spaces
  text = text.replace(/[\r\n\t]+/g, ' ');
  
  // Remove any NULL bytes or other control characters
  text = text.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  
  // Escape HTML entities
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  
  // Collapse multiple spaces into one
  text = text.replace(/\s+/g, ' ');
  
  // Trim whitespace
  text = text.trim();
  
  // If text is too long, truncate it
  if (text.length > 300) {
    text = text.substring(0, 297) + '...';
  }
  
  return text;
}

/**
 * Format the citations as a separate message with full text
 */
function formatCitationsMessage(citations, userId) {
  // Start building the content WITHOUT blockquote
  let citationsContent = '';
  
  // Add title
  citationsContent += '<b>ЦИТАТЫ И ИСТОЧНИКИ</b>\n\n';
  
  // Process each citation
  let citationCount = 0;
  const maxCitations = 10; // Limit to prevent message from being too long
  
  for (const citation of citations) {
    if (citationCount >= maxCitations) {
      citationsContent += `\n<i>... и еще ${citations.length - maxCitations} цитат(а)</i>\n`;
      break;
    }
    
    // Sanitize the citation text to remove ALL problematic characters
    const sanitizedText = sanitizeForBlockquote(citation.text);
    const sanitizedTitle = sanitizeForBlockquote(citation.title);
    
    // Build citation line
    // Format: number. "citation text" – Source Name
    const citationLine = `${citation.number}. "${sanitizedText}" – <a href="${citation.url}">${sanitizedTitle}</a>\n\n`;
    
    // Check if adding this citation would exceed safe length (leaving room for blockquote tags and truncation message)
    if (citationsContent.length + citationLine.length > 3800) {
      citationsContent += `\n<i>... и еще ${citations.length - citationCount} цитат(а)</i>\n`;
      break;
    }
    
    citationsContent += citationLine;
    citationCount++;
  }
  
  // Remove trailing newlines
  citationsContent = citationsContent.trim();
  
  // NOW wrap in blockquote - at this point we know it's under 4000 chars
  const finalMessage = `<blockquote expandable>${citationsContent}</blockquote>`;
  
  // Log info about the message
  console.log(`User ${userId}: Citations message built - ${citationCount} citations included, total length: ${finalMessage.length}`);
  console.log(`User ${userId}: First 500 chars of citations message:`, finalMessage.substring(0, 500));
  console.log(`User ${userId}: Last 100 chars of citations message:`, finalMessage.substring(finalMessage.length - 100));
  
  return finalMessage;
}

/**
 * Escape HTML entities except for our formatting tags
 */
function escapeHtml(text) {
  // First, temporarily replace our tags with placeholders
  const placeholders = [];
  let placeholderIndex = 0;
  
  // Patterns to preserve (updated for bracket format)
  const preservePatterns = [
    /<a\s+href="[^"]+"><b>\[\d+\]<\/b><\/a>/g,  // Updated pattern for bracket citations
    /<blockquote\s+expandable>[\s\S]*?<\/blockquote>/g,
    /<a\s+href="[^"]+">.*?<\/a>/g,
    /<b>.*?<\/b>/g,
    /<i>.*?<\/i>/g,
    /<u>.*?<\/u>/g,
    /<s>.*?<\/s>/g,
    /<code>.*?<\/code>/g,
    /<pre>.*?<\/pre>/g,
    /<\/?(b|i|u|s|code|pre|blockquote)>/g
  ];
  
  let processedText = text;
  
  for (const pattern of preservePatterns) {
    processedText = processedText.replace(pattern, (match) => {
      const placeholder = `__PLACEHOLDER_${placeholderIndex}__`;
      placeholders.push({ placeholder, original: match });
      placeholderIndex++;
      return placeholder;
    });
  }
  
  // Escape HTML entities
  processedText = processedText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  // Restore preserved tags
  for (const { placeholder, original } of placeholders) {
    processedText = processedText.replace(placeholder, original);
  }
  
  return processedText;
}

/**
 * Send message to Telegram with detailed logging
 */
async function sendTelegramMessage(chatId, text, userId = 'unknown') {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    
    const requestBody = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    
    // Log the full request for debugging
    console.log(`User ${userId}: Sending to Telegram API:`, JSON.stringify({
      ...requestBody,
      text: requestBody.text.substring(0, 500) + (requestBody.text.length > 500 ? '...' : '')
    }));
    
    // Log complete text if it contains blockquote
    if (text.includes('blockquote')) {
      console.log(`User ${userId}: Full blockquote message being sent (${text.length} chars):`, text);
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error(`Telegram API error for chat ${chatId}:`, error);
      
      // Additional debug logging for blockquote errors
      if (error.includes('blockquote')) {
        console.error(`User ${userId}: Blockquote error detected. Message length: ${text.length}`);
        console.error(`User ${userId}: Message starts with:`, text.substring(0, 200));
        console.error(`User ${userId}: Message ends with:`, text.substring(text.length - 200));
      }
      
      throw new Error(`Telegram API error: ${error}`);
    }
    
    return response.json();
    
  } catch (error) {
    console.error(`Failed to send message to chat ${chatId}:`, error.message);
    throw error;
  }
}

/**
 * Send typing action to show bot is processing
 */
async function sendTypingAction(chatId) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`;
    
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        action: 'typing'
      })
    });
  } catch (error) {
    console.error(`Failed to send typing action to chat ${chatId}:`, error.message);
    // Don't throw, this is not critical
  }
}
