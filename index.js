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

const FORM_BASE_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSey29MpuufCPAn55zRTSK1ZtGF3f9411ey6vn0bQJtArCS8dw/viewform?usp=pp_url&entry.703689566=';
const FORM_CUSTOMER_ENTRY = '&entry.1275810596=';
const MOISTURE_FORM_BASE_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSeDAvJ0Ho7gdZTBm-04PnM-dmaNiu3VpqnH4EMyiQkwQQCSuA/viewform?usp=pp_url&entry.931803057=';
const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;

const recentlyStarted = new Set();

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
    if (recentlyStarted.has(channelId)) {
      console.log(`🟡 Skipping duplicate start for ${channelId}`);
      return;
    }

    const info = await client.conversations.info({ channel: channelId });
    const channelName = info.channel?.name || '';

    if (channelName.includes('deal')) {
      recentlyStarted.add(channelId);
      setTimeout(() => recentlyStarted.delete(channelId), 10000);

      console.log('⏳ Starting workflow after 5 sec...');
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

app.action('select_crew_chief', async ({ ack, body, client, logger }) => {
  await ack();
  const channel = body.channel.id;
  const selectedUserId = body.actions[0].selected_user;

  try {
    const result = await client.conversations.info({ channel });
    const channelName = result.channel?.name || 'UNKNOWN';
    const dealId = extractDealIdFromChannelName(channelName);

    const userInfo = await client.users.info({ user: selectedUserId });
    const crewChiefName = userInfo?.user?.real_name || userInfo?.user?.profile?.display_name || userInfo?.user?.name || `<@${selectedUserId}>`;

    logger.info(`✅ Crew Chief selected: ${crewChiefName} for channel ${channelName}`);

    await client.chat.postMessage({
      channel,
      text: `👷 Crew Chief assigned is *${crewChiefName}*`
    });

    if (dealId) {
      const noteContent = `Crew Chief assigned is: ${crewChiefName}`;
      const response = await fetch(`https://api.pipedrive.com/v1/notes?api_token=${PIPEDRIVE_API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteContent, deal_id: dealId })
      });

      const result = await response.json();
      if (!result.success) {
        console.error('❌ Failed to post Crew Chief note to Pipedrive:', result);
      } else {
        console.log(`✅ Crew Chief logged to deal ${dealId}`);
      }
    } else {
      console.warn(`⚠️ Could not extract deal ID from channel name: ${channelName}`);
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

expressApp.post('/deal-created-task', async (req, res) => {
  try {
    const deal = req.body?.current;
    if (!deal || !deal.id) {
      console.warn('⚠️ Invalid deal payload:', req.body);
      return res.status(400).send('Missing deal data');
    }

    const dealId = deal.id;
    const typeOfService = deal['5b436b45b63857305f9691910b6567351b5517bc'];

    const validServices = [
      'Water Mitigation',
      'Fire Cleanup',
      'Contents',
      'Biohazard',
      'General Cleaning',
      'Duct Cleaning'
    ];

    if (!validServices.includes(typeOfService)) {
      console.log(`🔕 Deal ${dealId} type "${typeOfService}" not in target list`);
      return res.status(200).send('Type of service not applicable');
    }

    const taskData = {
      subject: 'Billed/Invoice',
      type: 'task',
      deal_id: dealId,
      due_date: new Date().toISOString().split('T')[0]
    };

    const taskRes = await fetch(`https://api.pipedrive.com/v1/activities?api_token=${PIPEDRIVE_API_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskData)
    });

    const taskJson = await taskRes.json();
    if (taskJson.success) {
      console.log(`✅ Task created for deal ${dealId}`);
      res.status(200).send('Task created');
    } else {
      console.error('❌ Failed to create task:', taskJson);
      res.status(500).send('Failed to create task');
    }
  } catch (err) {
    console.error('❌ Error in /deal-created-task:', err);
    res.status(500).send('Server error');
  }
});

expressApp.get('/', (req, res) => res.send('Computron is alive!'));

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡ Computron is running on port ${port}`);
})();
