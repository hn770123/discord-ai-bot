/** LLMへ渡す文脈を明示的な JSON と指示へ変換し、日時と発言者を曖昧にしない。 */
import type { ConversationEntry } from '../domain/conversation';

export interface PromptInput {
  now: Date;
  timezone: string;
  brief: string | null;
  conversation: readonly ConversationEntry[];
  request: string | null;
}

/** 生データをログへ出さず、モデルに必要な情報だけを単一プロンプトへ組み立てる。 */
export function buildAiPrompt(input: PromptInput): string {
  return [
    'あなたは小規模な家族向けDiscord Botです。会話に簡潔に応答してください。',
    'response、brief_update、reminder_addをschemaどおり返してください。',
    'Briefは長期的に有用な変化がある場合だけ更新し、それ以外はnullにしてください。',
    '曖昧な日時は推測でReminderにせず、responseで確認してください。',
    'Reminderのtargetは本人への明示的な依頼だけuser、それ以外はchannelです。',
    JSON.stringify({
      current_time_utc: input.now.toISOString(),
      user_timezone: input.timezone,
      user_brief: input.brief,
      conversation: input.conversation,
      current_request: input.request,
    }),
  ].join('\n');
}
