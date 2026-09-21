/**
 * `/ai` Application Command を Discord REST API へ登録する運用スクリプト。
 * 開発時は guild、Production は明示設定により global を選択でき、資格情報は環境変数だけから読む。
 */
/* global console, fetch, process */

const applicationId = requiredEnvironment('DISCORD_APPLICATION_ID');
const botToken = requiredEnvironment('DISCORD_BOT_TOKEN');
const scope = process.env.DISCORD_COMMAND_SCOPE ?? 'guild';

if (scope !== 'guild' && scope !== 'global') {
  throw new Error('DISCORD_COMMAND_SCOPE must be guild or global');
}

const endpoint =
  scope === 'guild'
    ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${requiredEnvironment('DISCORD_GUILD_ID')}/commands`
    : `https://discord.com/api/v10/applications/${applicationId}/commands`;

const command = {
  name: 'ai',
  description: 'AIに相談します',
  type: 1,
  options: [
    {
      name: 'prompt',
      description: 'AIへの依頼内容',
      type: 3,
      required: false,
      max_length: 2000,
    },
  ],
};

// PUTによる一括上書きを避け、同名コマンドの既存IDがあればPATCHで安全に更新する。
const listResponse = await fetch(endpoint, { headers: { authorization: `Bot ${botToken}` } });
if (!listResponse.ok) fail(listResponse.status);
const commands = await listResponse.json();
const existing = Array.isArray(commands)
  ? commands.find(
      (candidate) => candidate?.name === command.name && candidate?.type === command.type,
    )
  : undefined;
const writeUrl = existing?.id === undefined ? endpoint : `${endpoint}/${existing.id}`;
const response = await fetch(writeUrl, {
  method: existing?.id === undefined ? 'POST' : 'PATCH',
  headers: { authorization: `Bot ${botToken}`, 'content-type': 'application/json' },
  body: JSON.stringify(command),
});
if (!response.ok) fail(response.status);

console.log(`/ai command registered (${scope})`);

/** 必須環境変数を検証し、値そのものをエラーメッセージへ含めない。 */
function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

/** Discordエラーの本文を表示せず、状態コードだけで安全に失敗させる。 */
function fail(status) {
  throw new Error(`Discord command registration failed with status ${status}`);
}
