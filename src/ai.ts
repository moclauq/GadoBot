import { Bot, Context, InputFile } from 'grammy';
import { FileFlavor } from '@grammyjs/files';
import { Database } from 'bun:sqlite';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

type ExtendedContext = FileFlavor<Context>;

const db = new Database('database.sqlite');
db.exec(`
CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  type TEXT,
  text TEXT,
  user_id INTEGER,
  time DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gifs (
  base64 TEXT,
  hash TEXT NOT NULL,
  url INTEGER NOT NULL,
  time DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(hash, url)
);
`);

const messageContexts = new Map<number, Array<{ role: string; content: string }>>();
const lastBotMessages = new Map<number, number[]>();

export const logEvent = (event: string, type?: string, text?: string, userId?: number) => {
  db.prepare(
    'INSERT INTO logs (id, event, type, text, user_id) VALUES (?, ?, ?, ?, ?)'
  ).run(uuidv4(), event, type, text, userId);
};

export const handleError = (message: string, error: unknown, userId?: number) => {
  const errorMsg = error instanceof Error ? error.message : String(error);
  logEvent('ERROR', 'SYSTEM', `${message}: ${errorMsg}`, userId);
};

const extractCommand = (response: string, pattern: RegExp): [string | null, string] => {
  const match = response.match(pattern);
  return match ? [match[1], response.replace(match[0], '').trim()] : [null, response];
};

export const handleReaction = async (ctx: ExtendedContext, reaction: string | null) => {
  if (!reaction || !ctx.message?.message_id) return false;
  try {
    await ctx.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: reaction }]);
    logEvent('REACTION', 'SYSTEM', reaction, ctx.from?.id);
    return true;
  } catch (error) {
    handleError('Reaction failed', error, ctx.from?.id);
    return false;
  }
};

export const handleGifCommand = async (ctx: ExtendedContext) => {
  try {
    const row = db.prepare('SELECT * FROM gifs ORDER BY RANDOM() LIMIT 1').get();
    if (!row) return false;
    
    const fileBuffer = Buffer.from(row.base64, 'base64');
    await ctx.replyWithAnimation(new InputFile(fileBuffer, `gif_${row.hash}.mp4`));
    logEvent('GIF_SENT', 'SYSTEM', row.hash, ctx.from?.id);
    return true;
  } catch (error) {
    handleError('GIF send failed', error, ctx.from?.id);
    return false;
  }
};

export const getAIPicture = async (ctx: ExtendedContext, prompt: string) => {
    let loadingInterval: NodeJS.Timeout | null = null;
    
    try {
        loadingInterval = setInterval(() => {
            ctx.replyWithChatAction('upload_photo').catch(() => {});
        }, 2000);

        const imageUrl = `https://fluxwebui.com/generate/${encodeURIComponent(prompt)}?width=576&height=1024&seed=${Math.floor(Math.random() * 1000)}&model=flux&nologo=true&nofeed=true`;
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        
        if (!imageResponse.data) throw new Error('Empty image response');

        await ctx.replyWithPhoto(
            new InputFile(Buffer.from(imageResponse.data), 'image.jpg'),
            { 
                reply_to_message_id: ctx.message?.message_id 
            }
        );

        logEvent('RESPONSE', 'image', ctx.message?.document?.file_unique_id || 'unknown', ctx.from?.id);
        return imageResponse.data;
    } catch (error) {
        handleError('Image generation failed', error, ctx.from?.id);
        throw error;
    } finally {
        if (loadingInterval) clearInterval(loadingInterval);
    }
};

export const getAIResponse = async (prompt: string, context: Array<{ role: string; content: string }>, user_id) => {
  try {
    
    const response = await axios.post(process.env.AI_URL!, {
      model: process.env.AI_MODEL!,
      messages: [{ role: 'system', content: process.env.SYSTEM_PROMPT || '' },...context.slice(-8),{ role: 'user', content: prompt }],
      max_tokens: 1024,
      temperature: 0.7,
      top_p: 0.9,
      stream: false
    }, { 
      headers: { Authorization: `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000,
      validateStatus: (status) => status < 500
    });

    const result = response.data?.choices?.[0]?.message?.content;
    if (result) logEvent('RESPONSE', 'text', result, user_id);
    return result || null;
  } catch (error) {
    handleError('AI request failed', error);
    return null;
  }
};

export const handleGifUpload = async (ctx: ExtendedContext) => {
  try {
    const file = await ctx.getFile();
    if (!file.file_path) return;

    const existing = db.prepare('SELECT 1 FROM gifs WHERE hash = ?').get(file.file_unique_id);
    if (existing) return;

    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
    const { data } = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    
    db.prepare('INSERT OR IGNORE INTO gifs (base64, hash, url) VALUES (?, ?, ?)').run(
      Buffer.from(data).toString('base64'),
      file.file_unique_id,
      `t.me/${ctx.chat?.id}/${ctx.message?.message_id}`
    );
    logEvent('GIF_SAVED', 'SYSTEM', file.file_unique_id, ctx.from?.id);
  } catch (error) {
    handleError('GIF upload failed', error, ctx.from?.id);
  }
};

export const handleMessage = async (ctx: ExtendedContext, text: string, isReplyToBot: boolean, bot: Bot<ExtendedContext>) => {
  if (!ctx.chat?.id || !ctx.from?.id) return;

  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const context = isReplyToBot ? messageContexts.get(chatId) || [] : [];
  const userName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');

  try {
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1500 + 1000));
    await ctx.api.sendChatAction(chatId, 'typing');

    const aiResponse = await getAIResponse(`${userName}: ${text}`, context, ctx.from.id);
    if (!aiResponse) return;

    let [reaction, cleanResponse] = extractCommand(aiResponse, /%Reaction\(([^)]+)\)%/);
    const [gifCommand, finalResponse] = extractCommand(cleanResponse, /%sendGif%/);

    await handleReaction(ctx, reaction);
    if (gifCommand) await handleGifCommand(ctx);

    if (finalResponse) {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1500));
      await ctx.api.sendChatAction(chatId, 'typing');

      if (isReplyToBot) {
        messageContexts.set(chatId, [
          ...context.slice(-18),
          { role: 'user', content: text },
          { role: 'assistant', content: finalResponse }
        ]);
      }

      const escaped = finalResponse.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
      const sentMessage = await ctx.reply(escaped, {
        reply_to_message_id: ctx.message?.message_id,
        parse_mode: 'MarkdownV2'
      });

      if (isReplyToBot && sentMessage && !gifCommand) {
        const current = lastBotMessages.get(chatId) || [];
        lastBotMessages.set(chatId, [...current.slice(-9), sentMessage.message_id]);
      }
    }
  } catch (error) {
    handleError('Message processing failed', error, userId);
  }
};