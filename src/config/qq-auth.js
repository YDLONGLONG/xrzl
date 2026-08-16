// QQ互联 OAuth2.0 认证模块
const express = require('express');
const crypto = require('crypto');

const router = express.Router();

// QQ互联配置（从环境变量读取）
const QQ_CONFIG = {
  appid: process.env.QQ_APP_ID || '',
  appkey: process.env.QQ_APP_KEY || '',
  redirect_uri: process.env.QQ_REDIRECT_URI || 'http://localhost:3000/api/qq/callback'
};

// 临时token存储（token -> QQ用户信息），5分钟过期
const tokenStore = new Map();
const TOKEN_EXPIRE = 5 * 60 * 1000;

// 清理过期token
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of tokenStore) {
    if (now - data.createdAt > TOKEN_EXPIRE) {
      tokenStore.delete(token);
    }
  }
}, 60 * 1000);

// 生成state参数（防CSRF）
function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// 生成临时token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 路由1：跳转到QQ授权页面
router.get('/login', (req, res) => {
  if (!QQ_CONFIG.appid || !QQ_CONFIG.appkey) {
    return res.status(500).send('QQ登录未配置，请在 .env 文件中设置 QQ_APP_ID 和 QQ_APP_KEY');
  }

  const state = generateState();
  const authUrl = `https://graph.qq.com/oauth2.0/authorize?response_type=code&client_id=${QQ_CONFIG.appid}&redirect_uri=${encodeURIComponent(QQ_CONFIG.redirect_uri)}&state=${state}&scope=get_user_info`;

  res.redirect(authUrl);
});

// 路由2：QQ回调处理
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.redirect('/?qq_error=授权失败');
  }

  try {
    // 步骤1：用code换取access_token
    const tokenUrl = `https://graph.qq.com/oauth2.0/token?grant_type=authorization_code&client_id=${QQ_CONFIG.appid}&client_secret=${QQ_CONFIG.appkey}&code=${code}&redirect_uri=${encodeURIComponent(QQ_CONFIG.redirect_uri)}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenText = await tokenRes.text();

    // 解析access_token（返回格式：access_token=xxx&expires_in=xxx&refresh_token=xxx）
    const params = new URLSearchParams(tokenText);
    const access_token = params.get('access_token');

    if (!access_token) {
      console.error('获取access_token失败:', tokenText);
      return res.redirect('/?qq_error=获取令牌失败');
    }

    // 步骤2：获取openid
    const openidUrl = `https://graph.qq.com/oauth2.0/me?access_token=${access_token}`;
    const openidRes = await fetch(openidUrl);
    let openidText = await openidRes.text();

    // QQ返回格式：callback( {"client_id":"xxx","openid":"xxx"} );
    openidText = openidText.replace(/^callback\(/, '').replace(/\);?$/, '');
    const openidData = JSON.parse(openidText);
    const openid = openidData.openid;

    if (!openid) {
      console.error('获取openid失败:', openidText);
      return res.redirect('/?qq_error=获取用户标识失败');
    }

    // 步骤3：获取用户信息
    const userInfoUrl = `https://graph.qq.com/user/get_user_info?access_token=${access_token}&oauth_consumer_key=${QQ_CONFIG.appid}&openid=${openid}`;
    const userInfoRes = await fetch(userInfoUrl);
    const userInfo = await userInfoRes.json();

    if (userInfo.ret !== 0) {
      console.error('获取用户信息失败:', userInfo);
      return res.redirect('/?qq_error=获取用户信息失败');
    }

    // 步骤4：生成临时token，存储用户信息
    const token = generateToken();
    tokenStore.set(token, {
      openid,
      nickname: userInfo.nickname,
      figureurl: userInfo.figureurl_qq_2 || userInfo.figureurl_qq_1 || userInfo.figureurl,
      createdAt: Date.now()
    });

    // 重定向回首页，带token参数
    res.redirect(`/?qq_token=${token}`);

  } catch (err) {
    console.error('QQ登录回调错误:', err);
    res.redirect('/?qq_error=登录过程出错');
  }
});

// 路由3：前端用token换取用户信息
router.get('/userinfo', (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.json({ success: false, message: '缺少token' });
  }

  const data = tokenStore.get(token);
  if (!data) {
    return res.json({ success: false, message: 'token无效或已过期' });
  }

  if (Date.now() - data.createdAt > TOKEN_EXPIRE) {
    tokenStore.delete(token);
    return res.json({ success: false, message: 'token已过期' });
  }

  // 使用后删除token（一次性）
  tokenStore.delete(token);

  res.json({
    success: true,
    nickname: data.nickname,
    avatar: data.figureurl,
    openid: data.openid
  });
});

module.exports = router;
