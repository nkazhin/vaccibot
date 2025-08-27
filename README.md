# VacciBot - Telegram Vaccine Information Bot

A Telegram bot that provides evidence-based information about vaccines and infections using Anthropic's Claude API with citations feature. The bot responds to user questions by referencing official documents from healthcare organizations, providing inline citations for transparency and trust.

## Features

- **Evidence-based responses** - All answers are based on curated medical documents
- **Inline citations** - Responses include bracketed citation numbers [1][2] linking to source documents
- **Full citation text** - Second message shows exact text from source documents
- **Two-message format** - Main response followed by expandable citations block
- **Markdown support** - Converts Claude's markdown formatting (**bold**, *italics*) to Telegram HTML
- **Multi-document support** - Processes 13+ medical documents simultaneously
- **HTML formatting** - Supports rich text formatting in Telegram
- **Automatic truncation** - Handles Telegram's 4096 character limit gracefully

## Architecture

- **Platform**: Google Cloud Functions (Node.js 22)
- **AI Model**: Claude 3.5 Haiku (claude-3-5-haiku-20241022)
- **API**: Anthropic Messages API with Files API and Citations feature
- **Format**: Telegram HTML parse mode

## Project Structure

```
telegram-vaccibot/
├── index.js           # Main webhook handler and bot logic
├── documents.js       # Document database with file IDs and URLs
├── package.json       # Node.js dependencies
├── SystemPrompt.txt   # System prompt for Claude (required)
├── StartMessage.txt   # Welcome message for /start command (required)
└── README.md         # Documentation
```

## Setup Instructions

### Prerequisites

1. **Telegram Bot Token** - Create a bot via [@BotFather](https://t.me/botfather)
2. **Anthropic API Key** - Get from [Anthropic Console](https://console.anthropic.com/)
3. **Google Cloud Project** - With Cloud Functions enabled
4. **Node.js 22** - Runtime requirement

### Environment Variables

Configure these in your Google Cloud Function:

- `VaccibotToken` - Your Telegram bot token
- `ANTHROPIC_API_KEY` - Your Anthropic API key

### Deployment Steps

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd telegram-vaccibot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create required text files**
   - `SystemPrompt.txt` - Instructions for Claude's behavior (should include instructions to use citations)
   - `StartMessage.txt` - Welcome message for users

4. **Deploy to Google Cloud Functions**
   ```bash
   gcloud functions deploy telegramWebhook \
     --runtime nodejs22 \
     --trigger-http \
     --allow-unauthenticated \
     --set-env-vars ANTHROPIC_API_KEY=your-key,VaccibotToken=your-bot-token \
     --entry-point telegramWebhook
   ```

5. **Set Telegram webhook**
   ```bash
   curl -X POST https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook \
     -H "Content-Type: application/json" \
     -d '{"url":"https://<YOUR_GCF_URL>"}'
   ```

## Document Management

### Current Documents

The bot references 13 medical documents covering topics such as:
- Rabies prevention
- Vaccination preparation
- Influenza prophylaxis
- Pneumococcal vaccination for adults
- Primary immunodeficiency vaccination
- Premature infant vaccination
- HPV vaccines
- Hepatitis B vaccination
- Tick-borne encephalitis
- Pregnancy and vaccination
- Travel vaccinations in Russia
- Oral polio vaccine
- Tuberculosis vaccination

### Adding New Documents

1. Upload document to Anthropic Files API:
   ```bash
   curl https://api.anthropic.com/v1/files \
     -H "x-api-key: $ANTHROPIC_API_KEY" \
     -H "anthropic-beta: files-api-2025-04-14" \
     -F file=@document.pdf \
     -F purpose="document"
   ```

2. Add to `documents.js`:
   ```javascript
   {
     fileId: 'file_xxx',
     title: 'Document Title',
     url: 'https://link-to-public-version'
   }
   ```

## Citation System

### How Citations Work

1. **Document Processing** - All documents are attached to each user message with `citations: { enabled: true }`
2. **Model Response** - Claude generates structured citations with document indices and text locations
3. **Two-Message Format** - Main response with inline citations [1][2][3], followed by separate citations block
4. **Citation Formatting** - Citations are converted to bracketed numbers with links in main message
5. **Full Text Display** - Second message shows complete cited text in expandable "ЦИТАТЫ И ИСТОЧНИКИ" block
6. **Markdown Processing** - Claude's markdown formatting is converted to HTML tags
7. **Citation Extraction** - Full citation text (`cited_text`) is extracted from API response

### Citation Format Example

**First message (main response):**
> Гепатит B передается через **кровь**[1][2][3] и другие *биологические жидкости*[4].

**Second message (citations block):**
> **ЦИТАТЫ И ИСТОЧНИКИ**
> 
> 1. "Гепатит B - вирусная инфекция со 100% смертельным исходом" – [Гепатит B и прививка от него](https://bit.ly/booklet_hbv)
> 
> 2. "Передается через кровь и биологические жидкости" – [Профилактика гепатита B](https://bit.ly/hep_b_prevention)

The bracketed numbers [1], [2], etc. in the main message are clickable links that take users directly to the source documents. The second message contains the full text of what was cited, displayed in italics within quotes.

## Technical Details

### API Configuration

- **Model**: claude-3-5-haiku-20241022 (fast and cost-effective)
- **Max Tokens**: 4096
- **Beta Header**: `anthropic-beta: files-api-2025-04-14`
- **Citations**: Enabled on all document blocks

### Request Structure

```javascript
{
  model: "claude-3-5-haiku-20241022",
  max_tokens: 4096,
  system: systemPrompt,
  messages: [{
    role: "user",
    content: [
      // Document blocks with citations enabled
      {
        type: "document",
        source: { type: "file", file_id: "file_xxx" },
        title: "Document Title",
        citations: { enabled: true }  // Critical for citations to work
      },
      // User question
      {
        type: "text",
        text: "User's question"
      }
    ]
  }]
}
```

### Response Processing

1. **Parse content blocks** - Extract text and citations from API response
2. **Process markdown** - Convert `**bold**` → `<b>bold</b>`, `*italic*` → `<i>italic</i>`
3. **Map citations** - Link citation indices to document URLs
4. **Format citations** - Add bracketed numbers [1][2] as clickable links in main message
5. **Extract citation text** - Get `cited_text` field from each citation
6. **Create citations message** - Format full citations with italicized quoted text
7. **Escape HTML** - Protect user input while preserving formatting tags
8. **Send messages** - Main response first, then citations block

### Supported HTML Tags

The bot uses Telegram's HTML parse mode with these supported tags:
- `<b>bold</b>` - Bold text (from **markdown**)
- `<i>italic</i>` - Italic text (from *markdown* and for citation text)
- `<a href="url">link</a>` - Hyperlinks (for citations)
- `<blockquote expandable>` - Expandable quote blocks (for sources)
- `<code>`, `<pre>` - Code formatting (preserved if present)

## Logging

The bot includes comprehensive logging for debugging:

- User interactions (messages, commands)
- API request/response details
- Complete raw API responses
- Token usage statistics
- Citation processing details
- Error handling with user IDs

Example log entry:
```
User 234524401 (@username): Received message in chat 234524401
User 234524401: Calling Anthropic API with 13 documents...
User 234524401: API response received in 5234ms
User 234524401: Tokens - Input: 56507, Output: 656
User 234524401: Found 5 citations from 2 unique sources
User 234524401: Response sent successfully
User 234524401: Citations message sent successfully
```

## Limitations

- **No conversation history** - Each message is independent (stateless)
- **4096 character limit** - Long responses are truncated with a notice
- **Text only** - No support for images or other media types
- **Single language** - Primarily Russian content and interface

## Error Handling

- Graceful error messages to users
- Detailed error logging for debugging
- Always returns HTTP 200 to prevent Telegram webhook retries
- Fallback messages if text files can't be loaded
- Simple HTML escape function for citations to avoid parsing errors

### Telegram Formatting Errors

Common issues and solutions:

- **"Can't find end tag" errors** - Fixed by using separate escape functions for citations
- **"Unsupported tag" errors** - Only use supported HTML tags (no `<sup>`, `<sub>`, etc.)
- **Broken links** - Ensure URLs are properly escaped in href attributes
- **Character limit exceeded** - Messages over 4096 chars are automatically truncated

## Security Considerations

- API keys stored as environment variables
- No user data persistence
- Webhook accepts only authenticated Telegram requests
- Read-only document access via Files API

## Performance Notes

- **Claude 3.5 Haiku** - Chosen for fast response times and cost efficiency
- **Average response time** - 30-40 seconds (100k+ token inputs + citations feature possibly adds latency)
- **Two-message delivery** - Main response sent first, citations follow immediately
