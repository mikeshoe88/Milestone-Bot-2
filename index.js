// Computron Slack Bot for Railway — with proper /slack/events mounting
const { App, ExpressReceiver } = require('@slack/bolt');
const express = require('express');
const dayjs = require('dayjs');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

process.on('unhandledRejection', (err) => console.error('🔴 Unhandled Rejection:', err));
process.on('uncaughtException', (err) => console.error('🔴 Uncaught Exception:', err));

// ✅ Mount ExpressReceiver at /slack/events so Slack’s challenge check works
const expressReceiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver: expressReceiver,
});

const FORM_BASE_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSey29MpuufCPAn55zRTSK1ZtGF3f9411ey6vn0bQJtArCS8dw/viewform?usp=pp_url&entry.703689566=';
const FORM_CUSTOMER_ENTRY = '&entry.1275810596=';
const MOISTURE_FORM_BASE_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSeDAvJ0Ho7gdZTBm-04PnM-dmaNiu3VpqnH4EMyiQkwQQCSuA/viewform?usp=pp_url&entry.931803057=';
const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;

function extractDealIdFromChannelName(name) {
  const match = name.match(/deal(\d+)/);
  return match ? match[1] : null;
}

async function runStartWorkflow(channelId, client) {
  try {
    const result = await client.conversations.info({ channel: channelId });
    const channelName = result.channel?.name || 'UNKNOWN';
    const dealId = extractDealIdFromChannelName(channelName);
    const jobNumber = dealId ? channelName : 'UNKNOWN';

    let customerName = 'Customer';
    if (dealId) {
      const pipedriveResponse = await fetch(`https://api.pipedrive.com/v1/deals/${dealId}?api_token=${PIPEDRIVE_API_TOKEN}`);
      const dealData = await pipedriveResponse.json();
      customerName = dealData?.data?.person_name || 'Customer';
    }

    const formLink = `${FORM_BASE_URL}${encodeURIComponent(jobNumber)}${FORM_CUSTOMER_ENTRY}${encodeURIComponent(customerName)}`;

    await client.chat.postMessage({
      channel: channelId,
      text: `📋 Please fill out the *Initial Loss Note* form for *${jobNumber}*:\n<${formLink}|Initial Loss Note Form>`
    });

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
  } catch (err) {
    console.error('❌ Fatal error in runStartWorkflow():', err);
  }
}

app.event('member_joined_channel', async ({ event, client }) => {
  try {
    if (event.user === 'USLACKBOT') return;
    const channelId = event.channel;
    const info = await client.conversations.info({ channel: channelId });
    const channelName = info.channel?.name || '';

    if (channelName.includes('deal')) {
      console.log('⏳ Waiting 5 seconds before attempting start...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      await runStartWorkflow(channelId, client);
    }
  } catch (err) {
    console.error('❌ Error in member_joined_channel handler:', err);
  }
});

app.command('/start', async ({ command, ack, client }) => {
  await ack();
  await runStartWorkflow(command.channel_id, client);
});

app.action('select_crew_chief', async ({ ack, body, client }) => {
  await ack();
  const channel = body.channel.id;
  const selectedUserId = body.actions[0].selected_user;

  try {
    const result = await client.conversations.info({ channel });
    const channelName = result.channel?.name || 'UNKNOWN';
    const dealId = extractDealIdFromChannelName(channelName);

    const userInfo = await client.users.info({ user: selectedUserId });
    const crewChiefName = userInfo.user.real_name || userInfo.user.profile.display_name || `<@${selectedUserId}>`;

    await client.chat.postMessage({
      channel,
      text: `👷 Crew Chief assigned is *${crewChiefName}*`
    });

    try {
      await client.conversations.invite({ channel, users: selectedUserId });
    } catch (err) {
      if (err.data?.error !== 'already_in_channel') {
        console.warn('⚠️ Crew Chief invite error:', err);
      }
    }

    if (dealId) {
      const noteContent = `Crew Chief assigned is: ${crewChiefName}`;
      const noteResponse = await fetch(`https://api.pipedrive.com/v1/notes?api_token=${PIPEDRIVE_API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteContent, deal_id: dealId })
      });

      const noteResult = await noteResponse.json();
      if (!noteResult.success) {
        console.error('❌ Failed to post Crew Chief note to Pipedrive:', JSON.stringify(noteResult, null, 2));
      } else {
        console.log(`✅ Crew Chief logged to deal ${dealId}`);
      }
    }
  } catch (error) {
    console.error('❌ Error in crew chief assignment:', error);
  }
});

const expressApp = expressReceiver.app;
expressApp.use(express.json());

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
      text: `🦢 Please fill out the *${formTitle}* for *${jobNumber}*:\n<${formLink}|Moisture Check Form>`
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

// Health check
expressApp.get('/', (req, res) => res.send('Computron is alive!'));

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡ Computron is running on port ${port}`);
})();
