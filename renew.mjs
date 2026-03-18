// renew.mjs - PellaFree Auto Renewal Script (GitHub Actions)

import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const GOST_PROXY = process.env.GOST_PROXY || '';

function createAgent() {
  if (!GOST_PROXY) return undefined;
  if (GOST_PROXY.startsWith('socks')) {
    return new SocksProxyAgent(GOST_PROXY);
  }
  return new HttpsProxyAgent(GOST_PROXY);
}

const AGENT = createAgent();
if (AGENT) {
  console.log('[Proxy] enabled: ' + GOST_PROXY.replace(/:([^@]+)@/, ':***@'));
} else {
  console.log('[Proxy] no proxy configured, direct connection');
}

async function proxyFetch(url, options = {}) {
  if (AGENT) {
    options.agent = AGENT;
  }
  return fetch(url, options);
}

async function main() {
  console.log('[Start] PellaFree auto renewal starting...');

  console.log('[IP] Detecting exit IP...');
  try {
    const ipRes = await proxyFetch('https://api.ipify.org?format=json');
    const ipData = await ipRes.json();
    console.log('[IP] Current IP: ' + ipData.ip);
    const geoRes = await proxyFetch('http://ip-api.com/json/' + ipData.ip + '?lang=zh-CN');
    const geoData = await geoRes.json();
    console.log('[IP] Location: ' + geoData.country + ' ' + geoData.regionName + ' ' + geoData.city + ' (' + geoData.isp + ')');
  } catch (e) {
    console.warn('[IP] Detection failed:', e.message);
  }

  const env = {
    ACCOUNT:      process.env.ACCOUNT,
    TG_BOT_TOKEN: process.env.TG_BOT_TOKEN,
    TG_CHAT_ID:   process.env.TG_CHAT_ID,
  };

  const accounts = parseAccounts(env.ACCOUNT);
  if (accounts.length === 0) {
    console.log('[Error] No valid accounts found, check ACCOUNT env variable');
    process.exit(1);
  }

  const results = [];
  for (const account of accounts) {
    console.log('[Account] Processing: ' + account.email);
    try {
      const result = await processAccount(account);
      results.push(result);
    } catch (error) {
      console.error('[Account] Failed ' + account.email + ': ' + error.message);
      results.push({ email: account.email, error: error.message, servers: [], renewResults: [] });
    }
    await delay(3000);
  }

  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
    await sendTelegramNotification(env, results);
  } else {
    console.log('[TG] Telegram not configured, skipping notification');
  }

  console.log('[Done] Renewal task completed');
}

function parseAccounts(accountStr) {
  if (!accountStr) return [];
  return accountStr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && (line.includes('\u2014\u2013') || line.includes('---')))
    .map(line => {
      const separator = line.includes('\u2014\u2013') ? '\u2014\u2013' : '---';
      const [email, password] = line.split(separator).map(s => s.trim());
      return { email, password };
    })
    .filter(acc => acc.email && acc.password);
}

async function processAccount(account) {
  const authData = await login(account.email, account.password);
  if (!authData.token) {
    throw new Error('Login failed, unable to get token');
  }
  console.log('[Login] Success: ' + account.email);

  // Fix: wait after login for ad links to become available
  // Pella ad links take 2-3 seconds after login to switch from gray (claimed=true) to available (claimed=false)
  // Wait 6 seconds to ensure stable state
  console.log('[Wait] Waiting 6 seconds after login for ad links to become available...');
  await delay(6000);

  let servers = await getServers(authData.token);
  console.log('[Servers] Found ' + servers.length + ' server(s)');

  // Retry once if no unclaimed links found yet
  const totalUnclaimed = servers.reduce((sum, s) => {
    return sum + (s.renew_links || []).filter(l => l.claimed === false).length;
  }, 0);

  if (totalUnclaimed === 0) {
    console.log('[Wait] No available ads yet, waiting 5 more seconds and retrying...');
    await delay(5000);
    servers = await getServers(authData.token);
    console.log('[Servers] Refreshed: ' + servers.length + ' server(s)');
  }

  const beforeState = {};
  for (const server of servers) {
    const renewLinks = server.renew_links || [];
    beforeState[server.id] = {
      expiry: server.expiry,
      totalLinks: renewLinks.length,
      unclaimedLinks: renewLinks.filter(l => l.claimed === false).length,
    };
  }

  const renewResults = [];

  for (const server of servers) {
    const renewLinks = server.renew_links || [];
    const unclaimedLinks = renewLinks.filter(link => link.claimed === false);

    console.log('[Server] ' + server.id + ': total=' + renewLinks.length + ', available=' + unclaimedLinks.length + ', status=' + server.status);

    if (unclaimedLinks.length === 0) {
      renewResults.push({ serverId: server.id, skipped: true, message: 'no available links' });
    } else {
      let isRenewSuccess = false;

      for (let i = 0; i < unclaimedLinks.length; i++) {
        const renewLink = unclaimedLinks[i];
        console.log('[Renew] Processing link ' + (i + 1) + '/' + unclaimedLinks.length);
        console.log('[Renew] Ad link: ' + renewLink.link);

        try {
          const result = await renewServer(authData.token, server.id, renewLink.link);
          renewResults.push({ serverId: server.id, success: result.success, message: result.message });
          console.log('[Renew] Result: ' + (result.success ? 'success' : 'failed') + ' - ' + result.message);
          if (result.success) isRenewSuccess = true;
        } catch (error) {
          console.error('[Renew] Error:', error.message);
          renewResults.push({ serverId: server.id, success: false, message: error.message });
        }
        await delay(2000);
      }

      if (isRenewSuccess) {
        console.log('[Renew] Server ' + server.id + ' renewed successfully');
      }
    }

    const isOffline = server.status !== 'running';
    const isRenewSuccess = renewResults.some(r => r.serverId === server.id && !r.isRedeploy && !r.skipped && r.success);

    if (isRenewSuccess || isOffline) {
      if (isOffline && !isRenewSuccess) {
        console.log('[Redeploy] Server ' + server.id + ' is offline, triggering redeploy...');
      } else {
        console.log('[Redeploy] Server ' + server.id + ' renewed, sending redeploy request...');
      }
      try {
        await delay(2000);
        const redeployResult = await redeployServer(authData.token, server.id);
        renewResults.push({
          serverId: server.id,
          isRedeploy: true,
          success: redeployResult.success,
          message: isOffline && !isRenewSuccess
            ? 'offline redeploy: ' + redeployResult.message
            : redeployResult.message,
        });
        console.log('[Redeploy] Result: ' + (redeployResult.success ? 'success' : 'failed') + ' - ' + redeployResult.message);
      } catch (error) {
        console.error('[Redeploy] Error:', error.message);
        renewResults.push({ serverId: server.id, isRedeploy: true, success: false, message: error.message });
      }
    }
  }

  await delay(3000);
  servers = await getServers(authData.token);

  return {
    email: account.email,
    servers: servers.map(s => {
      const before = beforeState[s.id] || {};
      const renewLinks = s.renew_links || [];
      return {
        id: s.id,
        ip: s.ip,
        status: s.status,
        expiry: s.expiry,
        beforeExpiry: before.expiry,
        beforeUnclaimedLinks: before.unclaimedLinks || 0,
        totalLinks: renewLinks.length,
        currentUnclaimedLinks: renewLinks.filter(l => l.claimed === false).length,
      };
    }),
    renewResults,
  };
}

async function login(email, password) {
  const CLERK_API_VERSION = '2025-11-10';
  const CLERK_JS_VERSION  = '5.125.3';

  const signInUrl = 'https://clerk.pella.app/v1/client/sign_ins?__clerk_api_version=' + CLERK_API_VERSION + '&_clerk_js_version=' + CLERK_JS_VERSION;
  const signInBody = new URLSearchParams({
    locale: 'zh-CN',
    identifier: email,
    password,
    strategy: 'password',
  });

  const signInResponse = await proxyFetch(signInUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin':       'https://www.pella.app',
      'Referer':      'https://www.pella.app/',
      'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: signInBody.toString(),
  });

  if (!signInResponse.ok) {
    const errorBody = await signInResponse.text();
    console.error('[Login] Clerk error:', errorBody);
    throw new Error('Login request failed: ' + signInResponse.status + ' - ' + errorBody);
  }

  const signInData = await signInResponse.json();
  let sessionId = null;
  let token     = null;

  if (signInData.response && signInData.response.created_session_id) {
    sessionId = signInData.response.created_session_id;
  }
  if (signInData.client && signInData.client.sessions && signInData.client.sessions.length > 0) {
    const session = signInData.client.sessions[0];
    sessionId = sessionId || session.id;
    if (session.last_active_token && session.last_active_token.jwt) {
      token = session.last_active_token.jwt;
    }
  }

  const cookies      = signInResponse.headers.get('set-cookie') || '';
  const clientCookie = extractCookie(cookies, '__client');

  if (token) return { token, sessionId, clientCookie };

  if (sessionId) {
    const touchUrl = 'https://clerk.pella.app/v1/client/sessions/' + sessionId + '/touch?__clerk_api_version=' + CLERK_API_VERSION + '&_clerk_js_version=' + CLERK_JS_VERSION;
    const touchResponse = await proxyFetch(touchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin':       'https://www.pella.app',
        'Referer':      'https://www.pella.app/',
        'Cookie':       clientCookie ? '__client=' + clientCookie : '',
        'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: 'active_organization_id=',
    });
    if (touchResponse.ok) {
      const touchData = await touchResponse.json();
      if (touchData.sessions && touchData.sessions.length > 0) {
        token = touchData.sessions[0].last_active_token && touchData.sessions[0].last_active_token.jwt;
      }
      if (!token && touchData.last_active_token && touchData.last_active_token.jwt) {
        token = touchData.last_active_token.jwt;
      }
    }
  }

  if (!token && sessionId) {
    const tokensUrl = 'https://clerk.pella.app/v1/client/sessions/' + sessionId + '/tokens?__clerk_api_version=' + CLERK_API_VERSION + '&_clerk_js_version=' + CLERK_JS_VERSION;
    const tokensResponse = await proxyFetch(tokensUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin':       'https://www.pella.app',
        'Referer':      'https://www.pella.app/',
        'Cookie':       clientCookie ? '__client=' + clientCookie : '',
        'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: '',
    });
    if (tokensResponse.ok) {
      const tokensData = await tokensResponse.json();
      token = tokensData.jwt;
    }
  }

  return { token, sessionId, clientCookie };
}

async function getServers(token) {
  const response = await proxyFetch('https://api.pella.app/user/servers', {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/json',
      'Origin':        'https://www.pella.app',
      'Referer':       'https://www.pella.app/',
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
  if (!response.ok) throw new Error('Get servers failed: ' + response.status);
  const data = await response.json();
  return data.servers || [];
}

async function renewServer(token, serverId, renewLink) {
  const linkId = renewLink.split('/renew/')[1];
  if (!linkId) return { success: false, message: 'invalid link' };

  const response = await proxyFetch('https://api.pella.app/server/renew?id=' + linkId, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/json',
      'Origin':        'https://www.pella.app',
      'Referer':       'https://www.pella.app/',
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: '{}',
  });

  const responseText = await response.text();
  let data;
  try { data = JSON.parse(responseText); } catch { return { success: false, message: 'parse error' }; }

  if (data.success) return { success: true,  message: 'renewed successfully' };
  if (data.error)   return { success: false, message: data.error };
  return { success: false, message: 'unknown response' };
}

async function redeployServer(token, serverId) {
  const bodyParams = new URLSearchParams({ id: serverId });

  const response = await proxyFetch('https://api.pella.app/server/redeploy', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Origin':        'https://www.pella.app',
      'Referer':       'https://www.pella.app/',
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: bodyParams.toString(),
  });

  if (!response.ok) return { success: false, message: 'HTTP error ' + response.status };

  const responseText = await response.text();
  if (!responseText) return { success: true, message: 'redeploy command sent' };

  try {
    const data = JSON.parse(responseText);
    if (data.success || data.message === 'success' || response.status === 200)
      return { success: true, message: 'redeploy command sent' };
    if (data.error) return { success: false, message: data.error };
    return { success: false, message: 'unknown response' };
  } catch {
    return { success: true, message: 'redeploy command sent' };
  }
}

async function sendTelegramNotification(env, results) {
  let ipInfo = 'unknown';
  try {
    const ipRes = await proxyFetch('https://api.ipify.org?format=json');
    const ipData = await ipRes.json();
    const geoRes = await proxyFetch('http://ip-api.com/json/' + ipData.ip + '?lang=zh-CN');
    const geoData = await geoRes.json();
    ipInfo = ipData.ip + ' (' + geoData.country + ' ' + geoData.city + ' / ' + geoData.isp + ')';
  } catch (e) {
    ipInfo = 'detection failed';
  }

  const message = formatNotificationMessage(results, ipInfo);
  const res = await proxyFetch(
    'https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: message, parse_mode: 'HTML' }),
    }
  );
  if (!res.ok) {
    console.error('[TG] Send failed:', res.status, await res.text());
  } else {
    console.log('[TG] Notification sent');
  }
}

function formatNotificationMessage(results, ipInfo) {
  ipInfo = ipInfo || 'unknown';
  const lines = ['PellaFree Renewal Report', ''];
  const now   = new Date();

  lines.push('IP: <code>' + escapeHtml(ipInfo) + '</code>');
  lines.push('');

  for (const result of results) {
    lines.push('Account: ' + escapeHtml(result.email));

    if (result.error) {
      lines.push('Error: ' + escapeHtml(result.error));
      lines.push('');
      continue;
    }

    if (result.servers.length === 0) {
      lines.push('No servers found');
      lines.push('');
      continue;
    }

    for (const server of result.servers) {
      const statusText    = server.status === 'running' ? 'Running' : 'Offline';
      const remainingTime = calcRemaining(server.expiry, now);

      lines.push(statusText + ' | IP: <code>' + (server.ip || 'N/A') + '</code>');

      if (server.beforeExpiry && server.beforeExpiry !== server.expiry) {
        const beforeRemaining = calcRemaining(server.beforeExpiry, now);
        lines.push('Remaining: ' + beforeRemaining + ' -> ' + remainingTime + ' [Renewed]');
      } else {
        lines.push('Remaining: ' + remainingTime);
      }
      lines.push('Ads: ' + server.currentUnclaimedLinks + '/' + server.totalLinks + ' available');
    }

    const actualRenews = result.renewResults.filter(r => !r.skipped && !r.isRedeploy);
    const redeploys    = result.renewResults.filter(r => r.isRedeploy);

    if (actualRenews.length > 0) {
      const successCount = actualRenews.filter(r => r.success).length;
      lines.push('Renew: ' + successCount + '/' + actualRenews.length + ' success');
      for (const r of actualRenews.filter(r => !r.success)) {
        lines.push('  Failed: ' + escapeHtml(r.message));
      }
    } else {
      lines.push('Renew: no available ads');
    }

    if (redeploys.length > 0) {
      const successCount = redeploys.filter(r => r.success).length;
      lines.push('Redeploy: ' + successCount + '/' + redeploys.length + ' success');
      for (const r of redeploys.filter(r => !r.success)) {
        lines.push('  Failed: ' + escapeHtml(r.message));
      }
    }

    lines.push('');
  }

  lines.push('--------------------');
  lines.push('PellaFree Auto Renewal (GitHub Actions)');
  lines.push(now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
  return lines.join('\n');
}

function calcRemaining(expiry, now) {
  if (!expiry) return 'N/A';
  try {
    const match = expiry.match(/(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) return 'N/A';
    const hour = match[1], minute = match[2], second = match[3];
    const day  = match[4], month  = match[5], year   = match[6];
    const expiryDate = new Date(year + '-' + month + '-' + day + 'T' + hour + ':' + minute + ':' + second + 'Z');
    const diff       = expiryDate.getTime() - now.getTime();
    if (diff <= 0) return 'Expired';
    const days    = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours   = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (days > 0)  return days + 'd ' + hours + 'h ' + minutes + 'm';
    if (hours > 0) return hours + 'h ' + minutes + 'm';
    return minutes + 'm';
  } catch { return 'N/A'; }
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extractCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(name + '=([^;]+)'));
  return match ? match[1] : null;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('[Fatal] Script exited with error:', err);
  process.exit(1);
});
