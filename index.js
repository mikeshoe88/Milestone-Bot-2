// Computron Slack Bot with Express Receiver (No socketMode)
const { App, ExpressReceiver } = require('@slack/bolt');
const express = require('express');
const dayjs = require('dayjs');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

process.on('unhandledRejection', (err) => {
  console.error('🔴 Unhandled Rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('🔴 Uncaught Exception:', err);
});

const expressReceiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
  processBeforeResponse: true,
  bodyParser: false
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver: expressReceiver,
});

/* ====== ENV / CONSTANTS ====== */
const FORM_BASE_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSey29MpuufCPAn55zRTSK1ZtGF3f9411ey6vn0bQJtArCS8dw/viewform?usp=pp_url&entry.703689566=';
const FORM_CUSTOMER_ENTRY = '&entry.1275810596=';
const MOISTURE_FORM_BASE_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSeDAvJ0Ho7gdZTBm-04PnM-dmaNiu3VpqnH4EMyiQkwQQCSuA/viewform?usp=pp_url&entry.931803057=';
const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;

/* ====== Auto-invite config ====== */
const ALWAYS_INVITE_USER_IDS = [
  'U07AB7A4UNS', // Anastacio
  'U086RFE5UF2', // Jennifer
  'U05FYG3EMHS', // Kim
  'U06DKJ1BJ9W', // Danica
  'U05FPCPHJG6', // Mike
];

// Pipedrive custom field (Estimator)
const ESTIMATOR_FIELD_KEY = '0c1e4ec54e5c4b814a6cadbf0ed473ead1dff9d4';

// Map estimator display name -> Slack user ID
const ESTIMATOR_TO_SLACK = {
  'Kim':    'U05FYG3EMHS',
  'Danica': 'U06DKJ1BJ9W',
  'Lamar':  'U086RE5K3LY',
};

// Helper to invite and ignore harmless errors
async function safeInvite(client, channel, userIds = []) {
  if (!channel || !userIds.length) return;
  const unique = [...new Set(userIds)].filter(Boolean);
  if (!unique.length) return;
  try {
    console.log('📌 Attempting to invite users:', unique);
    await client.conversations.invite({ channel, users: unique.join(',') });
    console.log('👥 Invited users:', unique.join(','));
  } catch (e) {
    const err = e?.data?.error || e?.message;
    if (!['already_in_channel', 'cant_invite_self', 'not_in_channel'].includes(err)) {
      console.warn('[Computron] invite warning:', err);
    }
  }
}

/* ====== Identify THIS bot (Computron) ====== */
let BOT_USER_ID = process.env.COMPUTRON_BOT_USER_ID;
(async () => {
  if (!BOT_USER_ID) {
    try {
      const who = await app.client.auth.test();
      BOT_USER_ID = who.user_id;
      console.log('Computron BOT_USER_ID =', BOT_USER_ID);
    } catch (e) {
      console.warn('auth.test failed; set COMPUTRON_BOT_USER_ID in env', e?.message || e);
    }
  }
})();

/* ====== One-time-per-channel marker ====== */
const ILN_MARKER = '[ILN_INIT_v1]';

async function channelHasILN(client, channel) {
  try {
    const pins = await client.pins.list({ channel });
    if ((pins?.items || []).some(it => (it.message?.text || '').includes(ILN_MARKER))) return true;
  } catch {}
  const hist = await client.conversations.history({ channel, limit: 150 });
  return (hist?.messages || []).some(m => (m.user === BOT_USER_ID) && (m.text || '').includes(ILN_MARKER));
}

/* ====== Cooldown to prevent re-posting ====== */
const channelCooldown = new Map();
const COOLDOWN_MS = 60 * 1000;
const recentlyStarted = new Set();

function extractDealIdFromChannelName(name) {
  const match = String(name || '').match(/deal(\\d+)/i);
  return match ? match[1] : null;
}

async function runStartWorkflow(channelId, client) {
  try {
    const result = await client.conversations.info({ channel: channelId });
    const channelName = result.channel?.name || 'UNKNOWN';
    const dealId = extractDealIdFromChannelName(channelName);
    const jobNumber = dealId ? channelName : 'UNKNOWN';

    let customerName = 'Customer';
    let estimatorName = null;
    if (dealId) {
      const pipedriveResponse = await fetch(`https://api.pipedrive.com/v1/deals/${dealId}?api_token=${PIPEDRIVE_API_TOKEN}`);
      const dealData = await pipedriveResponse.json();
      customerName = dealData?.data?.person_name || 'Customer';

      const rawEstimator = dealData?.data?.[ESTIMATOR_FIELD_KEY];
      estimatorName =
        (rawEstimator && typeof rawEstimator === 'object' && 'value' in rawEstimator) ? rawEstimator.value :
        (typeof rawEstimator === 'string' ? rawEstimator : null);
    }

    const formLink = `${FORM_BASE_URL}${encodeURIComponent(jobNumber)}${FORM_CUSTOMER_ENTRY}${encodeURIComponent(customerName)}`;

    const markerMsg = await client.chat.postMessage({
      channel: channelId,
      text: `${ILN_MARKER} 📋 Please fill out the *Initial Loss Note* form for *${jobNumber}*:\n<${formLink}|Initial Loss Note Form>`
    });
    try { await client.pins.add({ channel: channelId, timestamp: markerMsg.ts }); } catch {}

    await client.chat.postMessage({
      channel: channelId,
      text: `Who is the assigned 👷 *Crew Chief*?`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Please select the *Crew Chief* for this job:' },
          accessory: {
            type: 'users_select',
            action_id: 'select_crew_chief'
          }
        }
      ]
    });

    const toInvite = [...ALWAYS_INVITE_USER_IDS];
    if (estimatorName && ESTIMATOR_TO_SLACK[estimatorName]) {
      toInvite.push(ESTIMATOR_TO_SLACK[estimatorName]);
    }
    await safeInvite(client, channelId, toInvite);

  } catch (err) {
    console.error('❌ Fatal error in runStartWorkflow():', err);
  }
}

app.event('member_joined_channel', async ({ event, client }) => {
  try {
    if (!BOT_USER_ID || event.user !== BOT_USER_ID) return;

    const channelId = event.channel;
    const info = await client.conversations.info({ channel: channelId });
    const channelName = info.channel?.name || '';
    if (!/deal/i.test(channelName)) return;

    if (await channelHasILN(client, channelId)) {
      console.log(`🟡 ILN already present in #${channelName}; skipping.`);
      return;
    }
    const last = channelCooldown.get(channelId) || 0;
    if (Date.now() - last < COOLDOWN_MS) return;
    channelCooldown.set(channelId, Date.now());

    if (recentlyStarted.has(channelId)) {
      console.log(`🟡 Skipping duplicate start for ${channelId}`);
      return;
    }
    recentlyStarted.add(channelId);
    setTimeout(() => recentlyStarted.delete(channelId), 10000);

    console.log('⏳ Starting workflow after 2 sec...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    await runStartWorkflow(channelId, client);
  } catch (err) {
    console.error('❌ Error in member_joined_channel handler:', err);
  }
});

app.command('/start', async ({ command, ack, client }) => {
  await ack();
  if (await channelHasILN(client, command.channel_id)) {
    return client.chat.postMessage({ channel: command.channel_id, text: 'ℹ️ Initial Loss Note was already posted for this channel.' });
  }
  await runStartWorkflow(command.channel_id, client);
});

app.action('select_crew_chief', async ({ ack, body, client, logger }) => {
  await ack();
  const channel = body?.channel?.id || body?.container?.channel_id;
  const selectedUserId = body?.actions?.[0]?.selected_user || body?.actions?.[0]?.selected_option?.value;
  if (!channel || !selectedUserId) return;

  try {
    try { await client.conversations.join({ channel }); } catch (e) {
      const err = e?.data?.error || e?.message;
      if (!['already_in_channel', 'method_not_supported_for_channel_type', 'not_in_channel'].includes(err)) {
        logger.warn('[Computron] join warning', err);
      }
    }

    try {
      await client.conversations.invite({ channel, users: selectedUserId });
      await client.chat.postMessage({ channel, text: `👷 Crew Chief <@${selectedUserId}> has been added to this job channel.` });
    } catch (e) {
      const err = e?.data?.error || e?.message;
      if (['already_in_channel', 'cant_invite_self'].includes(err)) {
        await client.chat.postMessage({ channel, text: `ℹ️ <@${selectedUserId}> is already in this channel.` });
      } else if (err === 'not_in_channel') {
        await client.chat.postMessage({ channel, text: `⚠️ I don't have permission to invite users here. Add me to this private channel and try again.` });
      } else {
        logger.error('[Computron] invite failed', err);
        await client.chat.postMessage({ channel, text: `⚠️ Couldn’t invite that Crew Chief (${err || 'unknown error'}).` });
      }
    }

    try {
      const info = await client.conversations.info({ channel });
      const channelName = info.channel?.name || 'UNKNOWN';
      const dealId = extractDealIdFromChannelName(channelName);

      if (dealId) {
        const userInfo = await client.users.info({ user: selectedUserId });
        const crewChiefName = userInfo?.user?.real_name || userInfo?.user?.profile?.display_name || userInfo?.user?.name || `<@${selectedUserId}>`;
        const noteContent = `Crew Chief assigned is: ${crewChiefName}`;
        const response = await fetch(`https://api.pipedrive.com/v1/notes?api_token=${PIPEDRIVE_API_TOKEN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: noteContent, deal_id: dealId })
        });
        const result = await response.json();
        if (!result.success) console.error('❌ Failed to post Crew Chief note to Pipedrive:', result);
      }
    } catch (e) {
      logger.warn('[Computron] PD note skip/warn', e?.message || e);
    }
  } catch (error) {
    console.error('❌ Error assigning Crew Chief:', error);
  }
});

const expressApp = expressReceiver.app;
expressApp.use(express.json());

expressApp.get('/slack/events', (req, res) => {
  res.status(200).send('Slack event route ready');
});
expressApp.post('/slack/events', (req, res) => {
  if (req.body?.type === 'url_verification') {
    return res.status(200).send(req.body.challenge);
  } else {
    res.status(200).end();
  }
});

expressApp.post('/trigger-mc-form', async (req, res) => {
  const jobNumber = req.body?.jobNumber;
  const mcCount = req.body?.mcCount || 1;
  const formDate = typeof req.body?.formDate === 'string' ? req.body.formDate : 'DATE_MISSING';

  if (!jobNumber || !jobNumber.toLowerCase().includes('deal')) {
    console.warn(`⚠️ Invalid or missing job number received: ${jobNumber}`);
    return res.status(400).send('Invalid job number');
  }

  const channel = jobNumber.toLowerCase();
  const formTitle = `Moisture Check ${mcCount} – ${formDate}`;
  const formLink = `${MOISTURE_FORM_BASE_URL}${encodeURIComponent(jobNumber)}`;

  try {
    await app.client.chat.postMessage({
      channel,
      text: `🧪 Please fill out the *${formTitle}* for *${jobNumber}*:\n<${formLink}|Moisture Check Form>`
    });
    console.log(`✅ MC${mcCount} form posted to #${channel}`);
    res.status(200).send('Moisture form posted');
  } catch (err) {
    console.error(`❌ Failed to post MC${mcCount} to #${channel}:`, err);
    res.status(500).send('Slack post failed');
  }
});

expressApp.post('/send-closeout-message', async (req, res) => {
  const jobNumber = req.body?.jobNumber;
  if (!jobNumber || !jobNumber.toLowerCase().includes('deal')) {
    console.warn(`⚠️ Invalid job number for closeout message: ${jobNumber}`);
    return res.status(400).send('Invalid job number');
  }

  const channel = jobNumber.toLowerCase();
  const message = `✅ Job completed for *${jobNumber}*\nPlease ensure all closeout forms are sent for file packaging.`;

  try {
    await app.client.chat.postMessage({ channel, text: message });
    console.log(`📦 Closeout message sent to #${channel}`);
    res.status(200).send('Closeout message sent');
  } catch (err) {
    console.error(`❌ Failed to send closeout message to #${channel}:`, err);
    res.status(500).send('Slack post failed');
  }
});

expressApp.get('/', (req, res) => res.send('Computron is alive!'));

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡ Computron is running on port ${port}`);
})();
