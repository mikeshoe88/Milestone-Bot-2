// Computron Slack Bot – Final Railway Version
const { App, ExpressReceiver } = require('@slack/bolt');
const express = require('express');
const dayjs = require('dayjs');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Error logging
process.on('unhandledRejection', (err) => console.error('🔴 Unhandled Rejection:', err));
process.on('uncaughtException', (err) => console.error('🔴 Uncaught Exception:', err));

// Setup Slack receiver
const expressReceiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events'
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver: expressReceiver
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
    const { channel } = await client.conversations.info({ channel: channelId });
    const channelName = channel?.name || 'UNKNOWN';
    const dealId = extractDealIdFromChannelName(channelName);
    const jobNumber = dealId ? channelName : 'UNKNOWN';

    let customerName = 'Customer';
    if (dealId) {
      const dealRes = await fetch(`https://api.pipedrive.com/v1/deals/${dealId}?api_token=${PIPEDRIVE_API_TOKEN}`);
      const dealData = await dealRes.json();
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
    console.error('❌ Error in runStartWorkflow:', err);
  }
}

app.event('member_joined_channel', async ({ event, client }) => {
  try {
    if (event.user === 'USLACKBOT') return;
    const { channel } = await client.conversations.info({ channel: event.channel });
    const channelName = channel?.name || '';
    if (channelName.includes('deal')) {
      await new Promise(r => setTimeout(r, 5000));
      await runStartWorkflow(event.channel, client);
    }
  } catch (err) {
    console.error('❌ Error in member_joined_channel:', err);
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
    const userInfo = await client.users.info({ user: selectedUserId });
    const crewChiefName = userInfo.user.real_name || userInfo.user.profile.display_name || `<@${selectedUserId}>`;

    await client.chat.postMessage({
      channel,
      text: `👷 Crew Chief assigned is *${crewChiefName}*`
    });

    await client.conversations.invite({ channel, users: selectedUserId }).catch(err => {
      if (err.data?.error !== 'already_in_channel') console.warn('⚠️ Invite error:', err);
    });

    const { channel: chanInfo } = await client.conversations.info({ channel });
    const dealId = extractDealIdFromChannelName(chanInfo.name);
    if (dealId) {
      const noteContent = `Crew Chief assigned is: ${crewChiefName}`;
      await fetch(`https://api.pipedrive.com/v1/notes?api_token=${PIPEDRIVE_API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteContent, deal_id: dealId })
      });
    }
  } catch (err) {
    console.error('❌ Error in crew chief assignment:', err);
  }
});

// Add endpoints manually
const expressApp = expressReceiver.app;
expressApp.use(express.json());

expressApp.post('/trigger-mc-form', async (req, res) => {
  const { jobNumber, mcCount = 1, formDate = 'DATE_MISSING' } = req.body;
  if (!jobNumber || !jobNumber.toLowerCase().includes('deal')) return res.status(400).send('Invalid job number');
  const channel = jobNumber.toLowerCase();
  const formTitle = `Moisture Check ${mcCount} – ${formDate}`;
  const formLink = `${MOISTURE_FORM_BASE_URL}${encodeURIComponent(jobNumber)}`;
  try {
    await app.client.chat.postMessage({ channel, text: `🧪 Please fill out the *${formTitle}* for *${jobNumber}*:\n<${formLink}|Moisture Check Form>` });
    res.status(200).send('Moisture form posted');
  } catch (err) {
    console.error('❌ Failed to post moisture form:', err);
    res.status(500).send('Slack post failed');
  }
});

expressApp.post('/send-closeout-message', async (req, res) => {
  const { jobNumber } = req.body;
  if (!jobNumber || !jobNumber.toLowerCase().includes('deal')) return res.status(400).send('Invalid job number');
  const channel = jobNumber.toLowerCase();
  try {
    await app.client.chat.postMessage({ channel, text: `✅ Job completed for *${jobNumber}*\nPlease ensure all closeout forms are sent for file packaging.` });
    res.status(200).send('Closeout message sent');
  } catch (err) {
    console.error('❌ Failed to send closeout message:', err);
    res.status(500).send('Slack post failed');
  }
});

// Root status
expressApp.get('/', (req, res) => res.send('Computron is alive!'));

// ✅ Final server binding for Railway
const port = process.env.PORT || 3000;
expressApp.listen(port, () => {
  console.log(`⚡ Computron is running on port ${port}`);
});
