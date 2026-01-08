import { prisma } from '../config/db';
import { adminAIService } from './admin-ai.service';
import { settingsService } from './settings.service';

export class AdminChatService {
  async getChats(userId: string) {
    return prisma.adminAiChat.findMany({
      where: { user_id: userId },
      orderBy: { last_used_at: 'desc' },
      include: {
        _count: {
          select: { messages: true }
        }
      }
    });
  }

  async createChat(userId: string, provider: string, modelId: string) {
    // Check limit
    const settings = await settingsService.getAll();
    const limit = parseInt(settings.limit_admin_ai_chats || '10', 10);
    
    if (limit > 0) {
      const count = await prisma.adminAiChat.count({ where: { user_id: userId } });
      if (count >= limit) {
        throw new Error(`Chat limit reached (${limit}). Delete old chats to create a new one.`);
      }
    }

    return prisma.adminAiChat.create({
      data: {
        user_id: userId,
        provider,
        model_id: modelId,
        title: `Chat with ${modelId}`
      }
    });
  }

  async getChat(chatId: string, userId: string) {
    const chat = await prisma.adminAiChat.findUnique({
      where: { id: chatId },
      include: {
        messages: {
          orderBy: { created_at: 'asc' }
        }
      }
    });

    if (!chat || chat.user_id !== userId) return null;
    return chat;
  }

  async deleteChat(chatId: string, userId: string) {
    const chat = await prisma.adminAiChat.findUnique({ where: { id: chatId } });
    if (!chat || chat.user_id !== userId) {
      throw new Error('Chat not found or access denied');
    }
    return prisma.adminAiChat.delete({ where: { id: chatId } });
  }

  async renameChat(chatId: string, userId: string, title: string) {
    const chat = await prisma.adminAiChat.findUnique({ where: { id: chatId } });
    if (!chat || chat.user_id !== userId) {
      throw new Error('Chat not found or access denied');
    }
    return prisma.adminAiChat.update({
      where: { id: chatId },
      data: { title }
    });
  }

  async sendMessage(userId: string, chatId: string, content: string, provider: string, modelId: string, permissions: string[], images: string[] = []) {
    const chat = await prisma.adminAiChat.findUnique({ where: { id: chatId } });
    if (!chat || chat.user_id !== userId) throw new Error('Chat not found');

    // Update chat model/title if changed
    if (chat.provider !== provider || chat.model_id !== modelId) {
      await prisma.adminAiChat.update({
        where: { id: chatId },
        data: { 
          provider, 
          model_id: modelId
        }
      });
    }

    // Save user message
    await prisma.adminAiChatMessage.create({
      data: {
        chat_id: chatId,
        role: 'user',
        content,
        images
      }
    });

    // Get history for context (excluding the just-added message effectively, as we pass it as 'question')
    // Actually, we need to pass the *previous* messages.
    const messages = await prisma.adminAiChatMessage.findMany({
      where: { chat_id: chatId },
      orderBy: { created_at: 'asc' }
    });
    
    // The last message is the one we just added.
    const historyForAi = messages.slice(0, -1).map(m => ({
      role: m.role,
      content: m.content,
      images: m.images
    }));

    // Filter actual images for Vision API
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const aiImages = images.filter(url => imageExtensions.some(ext => url.toLowerCase().endsWith(ext)));
    const otherFiles = images.filter(url => !imageExtensions.some(ext => url.toLowerCase().endsWith(ext)));

    let aiContent = content;
    if (otherFiles.length > 0) {
        aiContent += `\n\n[System: User attached files: ${otherFiles.join(', ')}]`;
    }

    const responseText = await adminAIService.ask(userId, permissions, provider, modelId, aiContent, historyForAi, aiImages);

    // Save assistant response
    const aiMsg = await prisma.adminAiChatMessage.create({
      data: {
        chat_id: chatId,
        role: 'assistant',
        content: responseText
      }
    });

    // Update last used
    await prisma.adminAiChat.update({
      where: { id: chatId },
      data: { last_used_at: new Date() }
    });

    return aiMsg;
  }
}

export const adminChatService = new AdminChatService();
