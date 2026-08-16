// 微信扫码 OAuth2.0 认证模块
const express = require('express');
const crypto = require('crypto');

const router = express.Router();

// 微信开放平台配置（从环境变量读取）
const WX_CONFIG = {
  appid: process.env.WX_APP_ID || '',
  secret: process.env.WX_APP_SECRET || '',
  redirect_uri: process.env.WX_REDIRECT_URI || 'http://localhost:3000/api/wechat/callback'
};

// 临时token存储（token -> 微信用户信息），5分钟过期
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

// 路由1：跳转到微信授权页面
router.get('/login', (req, res) => {
  if (!WX_CONFIG.appid || !WX_CONFIG.secret) {
    return res.status(500).send('微信登录未配置，请在 .env 文件中设置 WX_APP_ID 和 WX_APP_SECRET');
  }

  const state = generateState();
  const authUrl = `https://open.weixin.qq.com/connect/qrconnect?appid=${WX_CONFIG.appid}&redirect_uri=${encodeURIComponent(WX_CONFIG.redirect_uri)}&response_type=code&scope=snsapi_login&state=${state}`;

  res.redirect(authUrl);
});

// 路由2：微信回调处理
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.redirect('/?wx_error=授权失败');
  }

  try {
    // 步骤1：用code换取access_token
    const tokenUrl = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${WX_CONFIG.appid}&secret=${WX_CONFIG.secret}&code=${code}&grant_type=authorization_code`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();

    if (tokenData.errcode) {
      console.error('获取access_token失败:', tokenData);
      return res.redirect('/?wx_error=获取令牌失败');
    }

    const access_token = tokenData.access_token;
    const openid = tokenData.openid;

    if (!access_token || !openid) {
      console.error('获取access_token失败:', tokenData);
      return res.redirect('/?wx_error=获取用户标识失败');
    }

    // 步骤2：获取用户信息
    const userInfoUrl = `https://api.weixin.qq.com/sns/userinfo?access_token=${access_token}&openid=${openid}`;
    const userInfoRes = await fetch(userInfoUrl);
    const userInfo = await userInfoRes.json();

    if (userInfo.errcode) {
      console.error('获取用户信息失败:', userInfo);
      return res.redirect('/?wx_error=获取用户信息失败');
    }

    // 步骤3：生成临时token，存储用户信息
    const token = generateToken();
    tokenStore.set(token, {
      openid,
      nickname: userInfo.nickname,
      avatar: userInfo.headimgurl,
      createdAt: Date.now()
    });

    // 重定向回首页，带token参数
    res.redirect(`/?wx_token=${token}`);

  } catch (err) {
    console.error('微信登录回调错误:', err);
    res.redirect('/?wx_error=登录过程出错');
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
    avatar: data.avatar,
    openid: data.openid
  });
});

module.exports = router;
