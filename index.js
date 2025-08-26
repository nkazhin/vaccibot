const { Anthropic } = require('@anthropic-ai/sdk');
const { documents } = require('./documents');
const fs = require('fs').promises;
const path = require('path');

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
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
      console.log('Received update without message:', update);
      return res.status(200).send('OK');
    }

    const chatId = update.message.chat.id;
    const userId = update.message.from?.id;
    const username = update.message.from?.username || 'unknown';
    const firstName = update.message.from?.first_name || '';
    
    console.log(`Received message from user ${userId} (@${username}, ${firstName}) in chat ${chatId}`);
    
    if (!update.message.text) {
      console.log(`User ${userId}: Non-text message received, ignoring`);
      return res.status(200).send('OK');
    }

    const userMessage = update.message.text;
    console.log(`User ${userId}: Message text: "${userMessage.substring(0, 100)}${userMessage.length > 100 ? '...' : ''}"`);

    // Check for /start command
    if (userMessage.startsWith('/start')) {
      console.log(`User ${userId}: Handling /start command`);
      const startParams = userMessage.replace('/start', '').trim();
      if (startParams) {
        console.log(`User ${userId}: Start parameters: "${startParams}"`);
      }
      
      // Send start message
      await sendTelegramMessage(chatId, startMessage);
      console.log(`User ${userId}: Start message sent successfully`);
      return res.status(200).send('OK');
    }

    // Send typing action
    await sendTypingAction(chatId);
    console.log(`User ${userId}: Typing action sent`);

    // Call Anthropic API with citations
    console.log(`User ${userId}: Calling Anthropic API...`);
    const response = await getAnthropicResponse(userMessage, userId);
    console.log(`User ${userId}: Anthropic API response received`);

    // Process and format response with citations
    const formattedMessage = formatResponseWithCitations(response, userId);
    const messageLength = formattedMessage.length;
    console.log(`User ${userId}: Formatted message length: ${messageLength} characters`);

    // Check if message is too long for Telegram (4096 character limit)
    if (messageLength > 4096) {
      console.warn(`User ${userId}: Message too long (${messageLength} chars), truncating...`);
      // Send truncated message with warning
      const truncated = formattedMessage.substring(0, 4000) + '\n\n<i>[Сообщение было сокращено из-за ограничений Telegram]</i>';
      await sendTelegramMessage(chatId, truncated);
    } else {
      // Send response to user
      await sendTelegramMessage(chatId, formattedMessage);
    }
    
    console.log(`User ${userId}: Response sent successfully`);
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('Error processing webhook:', error);
    console.error('Error stack:', error.stack);
    
    // Try to send error message to user
    if (req.body?.message?.chat?.id) {
      const userId = req.body.message.from?.id || 'unknown';
      console.log(`User ${userId}: Sending error message to user`);
      
      try {
        await sendTelegramMessage(
          req.body.message.chat.id, 
          'Извините, произошла ошибка при обработке вашего запроса. Пожалуйста, попробуйте еще раз.'
        );
        console.log(`User ${userId}: Error message sent successfully`);
      } catch (sendError) {
        console.error(`User ${userId}: Failed to send error message:`, sendError);
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
    // Prepare document blocks with citations enabled
    const documentBlocks = documents.map(doc => ({
      type: 'document',
      source: {
        type: 'file',
        file_id: doc.fileId
      },
      title: doc.title,
      citations: { enabled: true }
    }));

    console.log(`User ${userId}: Attached ${documentBlocks.length} documents to request`);

    // Add user's question
    documentBlocks.push({
      type: 'text',
      text: userMessage
    });

    const startTime = Date.now();
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: documentBlocks
        }
      ]
    });
    
    const apiTime = Date.now() - startTime;
    console.log(`User ${userId}: Anthropic API call took ${apiTime}ms`);
    console.log(`User ${userId}: Response contains ${response.content.length} content blocks`);
    
    // Log token usage
    if (response.usage) {
      console.log(`User ${userId}: Token usage - Input: ${response.usage.input_tokens}, Output: ${response.usage.output_tokens}`);
    }

    return response;
    
  } catch (error) {
    console.error(`User ${userId}: Anthropic API error:`, error);
    throw error;
  }
}

/**
 * Format Anthropic response with citation superscripts and sources section
 */
function formatResponseWithCitations(response, userId) {
  let fullText = '';
  const citationMap = new Map(); // Map citation index to document info
  let citationCounter = 1;
  let totalCitations = 0;
  
  // Process each content block
  for (const block of response.content) {
    if (block.type === 'text') {
      let text = block.text;
      
      // If block has citations, add superscript numbers
      if (block.citations && block.citations.length > 0) {
        totalCitations += block.citations.length;
        const citationNumbers = [];
        
        for (const citation of block.citations) {
          const docIndex = citation.document_index;
          const doc = documents[docIndex];
          
          if (doc) {
            citationMap.set(citationCounter, {
              title: citation.document_title || doc.title,
              url: doc.url
            });
            citationNumbers.push(citationCounter);
            citationCounter++;
          } else {
            console.warn(`User ${userId}: Document not found at index ${docIndex}`);
          }
        }
        
        // Add superscript citations to text
        if (citationNumbers.length > 0) {
          const superscripts = citationNumbers
            .map(num => `<a href="${citationMap.get(num).url}"><b><sup>${num}</sup></b></a>`)
            .join('');
          text = text + superscripts;
        }
      }
      
      fullText += text;
    }
  }
  
  console.log(`User ${userId}: Total citations found: ${totalCitations}`);
  
  // Escape HTML entities in the main text (but preserve our tags)
  fullText = escapeHtml(fullText);
  
  // Add sources section if there are citations
  if (citationMap.size > 0) {
    fullText += '\n\n';
    fullText += formatSourcesSection(citationMap);
    console.log(`User ${userId}: Added sources section with ${citationMap.size} unique citations`);
  }
  
  return fullText;
}

/**
 * Format the expandable sources section
 */
function formatSourcesSection(citationMap) {
  let sourcesText = '<blockquote expandable><b>ИСТОЧНИКИ</b>\n\n';
  
  // Group consecutive citations with same URL
  const groups = [];
  let currentGroup = null;
  
  for (const [index, info] of citationMap.entries()) {
    if (currentGroup && currentGroup.url === info.url) {
      currentGroup.end = index;
    } else {
      currentGroup = {
        start: index,
        end: index,
        title: info.title,
        url: info.url
      };
      groups.push(currentGroup);
    }
  }
  
  // Format each group
  for (const group of groups) {
    const range = group.start === group.end 
      ? `${group.start}` 
      : `${group.start}-${group.end}`;
    
    sourcesText += `${range} – <a href="${group.url}">${escapeHtml(group.title)}</a>\n`;
  }
  
  sourcesText += '</blockquote>';
  
  return sourcesText;
}

/**
 * Escape HTML entities except for our formatting tags
 */
function escapeHtml(text) {
  // First, temporarily replace our tags with placeholders
  const placeholders = [];
  let placeholderIndex = 0;
  
  // Patterns to preserve
  const preservePatterns = [
    /<a\s+href="[^"]+"><b><sup>\d+<\/sup><\/b><\/a>/g,
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
 * Send message to Telegram
 */
async function sendTelegramMessage(chatId, text) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error(`Telegram API error for chat ${chatId}:`, error);
      throw new Error(`Telegram API error: ${error}`);
    }
    
    return response.json();
    
  } catch (error) {
    console.error(`Failed to send message to chat ${chatId}:`, error);
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
    console.error(`Failed to send typing action to chat ${chatId}:`, error);
    // Don't throw, this is not critical
  }
}
