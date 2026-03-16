// pella.js - GitHub Actions 自动代理版

// 自动启用 ALL_PROXY（如果 USE_GOST=1）
if (process.env.USE_GOST === "1") {
  if (!process.env.ALL_PROXY) {
    process.env.ALL_PROXY = "http://127.0.0.1:8080";
    console.log("🔌 已自动启用 ALL_PROXY = http://127.0.0.1:8080");
  }
}

async function main() {
  console.log("开始执行 PellaFree 自动续期...");

  const accounts = parseAccounts(process.env.ACCOUNT);
  if (accounts.length === 0) {
    console.log("未找到有效账号");
    return;
  }

  const results = [];

  for (const account of accounts) {
    console.log(`处理账号: ${account.email}`);
    try {
      const result = await processAccount(account);
      results.push(result);
    } catch (error) {
      console.error(`账号 ${account.email} 处理失败:`, error.message);
      results.push({
        email: account.email,
        error: error.message,
        servers: [],
        renewResults: []
      });
    }
    await delay(3000);
  }

  if (process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID) {
    await sendTelegramNotification(results);
  }

  console.log("续期任务完成");
}

function parseAccounts(accountStr) {
  if (!accountStr) return [];

  return accountStr
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && line.includes("-----"))
    .map(line => {
      const [email, password] = line.split("-----").map(s => s.trim());
      return { email, password };
    })
    .filter(acc => acc.email && acc.password);
}

async function processAccount(account) {
  const authData = await login(account.email, account.password);

  if (!authData.token) {
    throw new Error("登录失败，无法获取 token");
  }

  console.log(`账号 ${account.email} 登录成功`);

  let servers = await getServers(authData.token);
  console.log(`获取到 ${servers.length} 个服务器`);

  const beforeState = {};
  for (const server of servers) {
    const renewLinks = server.renew_links || [];
    const unclaimedCount = renewLinks.filter(l => l.claimed === false).length;
    beforeState[server.id] = {
      expiry: server.expiry,
      totalLinks: renewLinks.length,
      unclaimedLinks: unclaimedCount
    };
  }

  const renewResults = [];
  for (const server of servers) {
    const renewLinks = server.renew_links || [];
    const unclaimedLinks = renewLinks.filter(link => link.claimed === false);

    console.log(`服务器 ${server.id}: 总${renewLinks.length}, 可用${unclaimedLinks.length}`);

    if (unclaimedLinks.length === 0) {
      renewResults.push({
        serverId: server.id,
        skipped: true,
        message: "无可用链接"
      });
      continue;
    }

    let isRenewSuccess = false;

    for (let i = 0; i < unclaimedLinks.length; i++) {
      const renewLink = unclaimedLinks[i];

      console.log(`处理续期链接 ${i + 1}/${unclaimedLinks.length}`);
      console.log(`>>> 真实的广告链接内容是: ${renewLink.link}`);

      try {
        const result = await renewServer(authData.token, server.id, renewLink.link);
        renewResults.push({
          serverId: server.id,
          success: result.success,
          message: result.message
        });
        console.log(`续期结果: ${result.success ? "成功" : "失败"} - ${result.message}`);

        if (result.success) {
          isRenewSuccess = true;
        }
      } catch (error) {
        console.error(`续期失败:`, error.message);
        renewResults.push({
          serverId: server.id,
          success: false,
          message: error.message
        });
      }
      await delay(2000);
    }

    if (isRenewSuccess) {
      console.log(`服务器 ${server.id} 续期成功，正在发送重启请求...`);
      try {
        await delay(2000);
        const redeployResult = await redeployServer(authData.token, server.id);
        renewResults.push({
          serverId: server.id,
          isRedeploy: true,
          success: redeployResult.success,
          message: redeployResult.message
        });
        console.log(`重启结果: ${redeployResult.success ? "成功" : "失败"} - ${redeployResult.message}`);
      } catch (error) {
        console.error(`重启失败:`, error.message);
        renewResults.push({
          serverId: server.id,
          isRedeploy: true,
          success: false,
          message: error.message
        });
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
        currentUnclaimedLinks: renewLinks.filter(l => l.claimed === false).length
      };
    }),
    renewResults
  };
}

async function login(email, password) {
  const CLERK_API_VERSION = "2025-11-10";
  const CLERK_JS_VERSION = "5.125.3";

  const signInUrl = `https://clerk.pella.app/v1/client/sign_ins?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`;

  const signInBody = new URLSearchParams({
    locale: "zh-CN",
    identifier: email,
    password: password,
    strategy: "password"
  });

  const signInResponse = await fetch(signInUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "https://www.pella.app",
      "Referer": "https://www.pella.app/",
      "User-Agent": "Mozilla/5.0"
    },
    body: signInBody.toString()
  });

  if (!signInResponse.ok) {
    const errorBody = await signInResponse.text();
    console.error("Clerk 详细报错内容:", errorBody);
    throw new Error(`登录请求失败: ${signInResponse.status} - ${errorBody}`);
  }

  const signInData = await signInResponse.json();

  let sessionId = null;
  let token = null;

  if (signInData.response?.created_session_id) {
    sessionId = signInData.response.created_session_id;
  }

  if (signInData.client?.sessions?.length > 0) {
    const session = signInData.client.sessions[0];
    sessionId = sessionId || session.id;
    if (session.last_active_token?.jwt) {
      token = session.last_active_token.jwt;
    }
  }

  const cookies = signInResponse.headers.get("set-cookie") || "";
  const clientCookie = extractCookie(cookies, "__client");

  if (token) return { token, sessionId, clientCookie };

  if (sessionId) {
    const touchUrl = `https://clerk.pella.app/v1/client/sessions/${sessionId}/touch?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`;

    const touchResponse = await fetch(touchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://www.pella.app",
        "Referer": "https://www.pella.app/",
        "Cookie": clientCookie ? `__client=${clientCookie}` : "",
        "User-Agent": "Mozilla/5.0"
      },
      body: "active_organization_id="
    });

    if (touchResponse.ok) {
      const touchData = await touchResponse.json();
      if (touchData.sessions?.length > 0) {
        token = touchData.sessions[0].last_active_token?.jwt;
      }
      if (!token && touchData.last_active_token?.jwt) {
        token = touchData.last_active_token.jwt;
      }
    }
  }

  if (!token && sessionId) {
    const tokensUrl = `https://clerk.pella.app/v1/client/sessions/${sessionId}/tokens?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`;

    const tokensResponse = await fetch(tokensUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://www.pella.app",
        "Referer": "https://www.pella.app/",
        "Cookie": clientCookie ? `__client=${clientCookie}` : "",
        "User-Agent": "Mozilla/5.0"
      },
      body: ""
    });

    if (tokensResponse.ok) {
      const tokensData = await tokensResponse.json();
      token = tokensData.jwt;
    }
  }

  return { token, sessionId, clientCookie };
}

async function getServers(token) {
  const response = await fetch("https://api.pella.app/user/servers", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: "https://www.pella.app",
      Referer: "https://www.pella.app/",
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    throw new Error(`获取服务器列表失败: ${response.status}`);
  }

  const data = await response.json();
  return data.servers || [];
}

async function renewServer(token, serverId, renewLink) {
  const linkId = renewLink.split("/renew/")[1];
  if (!linkId) {
    return { success: false, message: "无效链接" };
  }

  const response = await fetch(`https://api.pella.app/server/renew?id=${linkId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: "https://www.pella.app",
      Referer: "https://www.pella.app/",
      "User-Agent": "Mozilla/5.0"
    },
    body: "{}"
  });

  const responseText = await response.text();
  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    return { success: false, message: "解析失败" };
  }

  if (data.success) return { success: true, message: "续期成功" };
  if (data.error) return { success: false, message: data.error };
  return { success: false, message: "未知响应" };
}

async function redeployServer(token, serverId) {
  const bodyParams = new URLSearchParams({ id: serverId });

  const response = await fetch("https://api.pella.app/server/redeploy", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://www.pella.app",
      Referer: "https://www.pella.app/",
      "User-Agent": "Mozilla/5.0"
    },
    body: bodyParams.toString()
  });

  if (!response.ok) {
    return { success: false, message: `HTTP异常 ${response.status}` };
  }

  const responseText = await response.text();

  if (!responseText) {
    return { success: true, message: "重启指令已发送" };
  }

  try {
    const data = JSON.parse(responseText);
    if (data.success || data.message === "success" || response.status === 200) {
      return { success: true, message: "重启指令已发送" };
    }
    if (data.error) return { success: false, message: data.error };
    return { success: false, message: "未知响应" };
  } catch {
    return { success: true, message: "重启指令已发送" };
  }
}

async function sendTelegramNotification(results) {
  const message = formatNotificationMessage(results);

  await fetch(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TG_CHAT_ID,
      text: message,
      parse_mode: "HTML"
    })
  });
}

function formatNotificationMessage(results) {
  const lines = ["📋 PellaFree 续期报告", ""];
  const now = new Date();

  for (const result of results) {
    lines.push(`账号: ${escapeHtml(result.email)}`);

    if (result.error) {
      lines.push(`错误: ${escapeHtml(result.error)}`);
      lines.push("");
      continue;
    }

    if (result.servers.length === 0) {
      lines.push("暂无服务器");
      lines.push("");
      continue;
    }

    for (const server of result.servers) {
      const statusText = server.status === "running" ? "运行中" : "已关机";

      lines.push(`${statusText} | IP: <code>${server.ip || "N/A"}</code>`);

      const remainingTime = calcRemaining(server.expiry, now);
      if (server.beforeExpiry && server.beforeExpiry !== server.expiry) {
        const beforeRemaining = calcRemaining(server.beforeExpiry, now);
        lines.push(`剩余: ${beforeRemaining} → ${remainingTime} [已续期]`);
      } else {
        lines.push(`剩余: ${remainingTime}`);
      }

      lines.push(`广告: ${server.currentUnclaimedLinks}/${server.totalLinks} 可用`);
    }

    const actualRenews = result.renewResults.filter(r => !r.skipped && !r.isRedeploy);
    const redeploys = result.renewResults.filter(r => r.isRedeploy);

    if (actualRenews.length > 0) {
      const successCount = actualRenews.filter(r => r.success).length;
      lines.push(`续期: ${successCount}/${actualRenews.length} 成功`);
      for (const r of actualRenews.filter(r => !r.success)) {
        lines.push(`  失败: ${escapeHtml(r.message)}`);
      }
    } else {
      lines.push(`续期: 无可用广告`);
    }

    if (redeploys.length > 0) {
      const successCount = redeploys.filter(r => r.success).length;
      lines.push(`重启: ${successCount}/${redeploys.length} 成功`);
      for (const r of redeploys.filter(r => !r.success)) {
        lines.push(`  重启失败: ${escapeHtml(r.message)}`);
      }
    }

    lines.push("");
  }

  lines.push("────────────────────");
  lines.push("PellaFree Auto Renewal");
  lines.push(`${now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);

  return lines.join("\n");
}

function calcRemaining(expiry, now) {
  if (!expiry) return "N/A";

  try {
    const match = expiry.match(/(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) return "N/A";

    const [, hour, minute, second, day, month, year] = match;
    const expiryDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);

    const diff = expiryDate.getTime() - now.getTime();

    if (diff <= 0) return "已过期";

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (days > 0) return `${days}天${hours}时${minutes}分`;
    if (hours > 0) return `${hours}时${minutes}分`;
    return `${minutes}分`;
  } catch {
    return "N/A";
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function extractCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main();
