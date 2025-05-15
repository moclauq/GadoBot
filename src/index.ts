import { Bot } from 'grammy';
import { FileFlavor } from '@grammyjs/files';
import { handleMessage, handleGifUpload, handleError, getAIPicture } from './ai';

type ExtendedContext = FileFlavor<Context>;

const bot = new Bot<ExtendedContext>(process.env.TELEGRAM_TOKEN!);
const chatQueues = new Map<number, Promise<void>>();

const queueMessage = (ctx: ExtendedContext, handler: () => Promise<void>) => {
  const chatId = ctx.chat.id;
  const previous = chatQueues.get(chatId) || Promise.resolve();
  const current = previous.then(handler).catch(e => handleError('Queue error', e, ctx.from?.id));
  chatQueues.set(chatId, current);
  return current;
};

bot.on('message', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId || chatId !== Number(process.env.ALLOWED_CHAT_ID)) return;

  await queueMessage(ctx, async () => {
    try {
      if (ctx.message?.animation || ctx.message?.document?.mime_type === 'video/mp4') {
        await handleGifUpload(ctx);
        return;
      }

      const messageText = ctx.message?.text;
      if (!messageText) return;

	  const drawRegex = new RegExp(`^(${process.env.TRIGGER_WORD}\\s+)?(draw|нарисуй)\\s+(.+)$`, 'i');
	  const drawMatch = messageText.match(drawRegex);

	  if (drawMatch && drawMatch[3]) {
      const imagePrompt = drawMatch[3].trim();
    
      try {
         await getAIPicture(ctx, imagePrompt);
      } catch (error) {
         console.error('Image generation error:', error);
      }
       return;
      }
      const isReplyToBot = ctx.message.reply_to_message?.from?.id === bot.botInfo.id;
      const triggerRegex = new RegExp(`^${process.env.TRIGGER_WORD}\\s*(.*)`, 'i');
      const isTrigger = triggerRegex.test(messageText);

      if (isTrigger || isReplyToBot) {
        const commandText = isTrigger ? messageText.replace(triggerRegex, '$1').trim() : messageText;
        await handleMessage(ctx, commandText, isReplyToBot, bot);
      }
    } catch (error) {
      console.error('Message processing failed:', error);
    }
  });
});

bot.start({ onStart: () => console.log('[SYSTEM] Bot started') });