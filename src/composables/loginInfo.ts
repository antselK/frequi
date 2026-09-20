import { ofetch } from 'ofetch';

import type {
  AuthPayload,
  AuthResponse,
  BotDescriptors,
  AuthStorage,
  AuthStorageMulti,
  BotDescriptor,
} from '@/types';

const AUTH_LOGIN_INFO = 'ftAuthLoginInfo';
const APIBASE = '/api/v1';

// Global state for all login infos
const allLoginInfos = useStorage<AuthStorageMulti>(AUTH_LOGIN_INFO, {});

function normalizeStoredBotOrder() {
  const entries = Object.entries(allLoginInfos.value);
  if (entries.length <= 1) {
    return;
  }

  const ordered = [...entries].sort((a, b) => {
    const aSort = a[1]?.sortId ?? Number.MAX_SAFE_INTEGER;
    const bSort = b[1]?.sortId ?? Number.MAX_SAFE_INTEGER;
    if (aSort === bSort) {
      return a[0].localeCompare(b[0]);
    }
    return aSort - bSort;
  });

  let changed = false;
  const normalized: AuthStorageMulti = {};
  ordered.forEach(([botId, info], index) => {
    if ((info.sortId ?? -1) !== index) {
      changed = true;
    }
    normalized[botId] = {
      ...info,
      sortId: index,
    };
  });

  if (changed) {
    allLoginInfos.value = normalized;
  }
}

normalizeStoredBotOrder();

/**
 * Get available bots with their descriptors
 */
export const loggedInBots = computed<BotDescriptors>(() => {
  const allInfo = allLoginInfos.value;
  const response: BotDescriptors = {};
  Object.keys(allInfo)
    .sort((a, b) => {
      const aSort = allInfo[a]?.sortId ?? Number.MAX_SAFE_INTEGER;
      const bSort = allInfo[b]?.sortId ?? Number.MAX_SAFE_INTEGER;
      if (aSort === bSort) {
        return a.localeCompare(b);
      }
      return aSort - bSort;
    })
    .forEach((k, idx) => {
      const bot = allInfo[k];
      if (!bot) return;
      response[k] = {
        botId: k,
        botName: bot.botName,
        botUrl: bot.apiUrl,
        sortId: bot.sortId ?? idx,
      };
    });

  return response;
});

export function ensureBotLoginInfo(
  botId: string,
  payload: { botName: string; botUrl: string; sortId: number },
) {
  const existing = allLoginInfos.value[botId];
  allLoginInfos.value = {
    ...allLoginInfos.value,
    [botId]: {
      botName: payload.botName,
      apiUrl: payload.botUrl,
      username: existing?.username ?? '',
      refreshToken: existing?.refreshToken ?? '',
      accessToken: existing?.accessToken ?? '',
      autoRefresh: existing?.autoRefresh ?? false,
      sortId: existing?.sortId ?? payload.sortId,
    },
  };
}

/** Build a UTF-8 safe HTTP Basic Authorization header value. */
function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

export function useLoginInfo(botId: string) {
  console.log('botId', botId);

  function mergeLoginInfo(newValues: Partial<AuthStorage>) {
    const existing = allLoginInfos.value[botId];
    if (!existing) {
      return;
    }
    allLoginInfos.value = {
      ...allLoginInfos.value,
      [botId]: {
        ...existing,
        ...newValues,
      },
    };
  }

  const currentInfo = computed({
    get: () => allLoginInfos.value[botId]!,
    set: (val) => {
      const existing = allLoginInfos.value[botId];
      allLoginInfos.value = {
        ...allLoginInfos.value,
        [botId]: {
          ...existing,
          ...val,
        },
      };
    },
  });

  const autoRefresh = computed({
    get: () => currentInfo.value.autoRefresh,
    set: (val) => mergeLoginInfo({ autoRefresh: val }),
  });
  const accessToken = computed(() => currentInfo.value.accessToken);

  const baseUrl = computed<string>(() => {
    const baseURL = currentInfo.value.apiUrl;
    if (baseURL === null) {
      return APIBASE;
    }
    if (!baseURL.endsWith(APIBASE)) {
      return `${baseURL}${APIBASE}`;
    }
    return `${baseURL}${APIBASE}`;
  });

  const baseWsUrl = computed<string>(() => {
    const baseURL = baseUrl.value;
    if (baseURL.startsWith('http://')) {
      return baseURL.replace('http://', 'ws://');
    }
    if (baseURL.startsWith('https://')) {
      return baseURL.replace('https://', 'wss://');
    }
    return '';
  });

  /**
   * Get login info for current bot
   */
  function getLoginInfo(): AuthStorage {
    const allLoginBot = allLoginInfos.value[botId];
    if (allLoginBot && 'apiUrl' in allLoginBot && 'refreshToken' in allLoginBot) {
      return allLoginBot;
    }
    return {
      botName: '',
      apiUrl: '',
      username: '',
      refreshToken: '',
      accessToken: '',
      autoRefresh: false,
    };
  }

  function updateBot(newValues: Partial<BotDescriptor>): void {
    const existing = allLoginInfos.value[botId];
    if (!existing) {
      return;
    }

    allLoginInfos.value = {
      ...allLoginInfos.value,
      [botId]: {
        ...existing,
        ...newValues,
      },
    };
  }

  function setRefreshTokenExpired(): void {
    mergeLoginInfo({ refreshToken: '', accessToken: '' });
  }

  function logout(): void {
    console.log('Logging out');
    const nextInfo = { ...allLoginInfos.value };
    delete nextInfo[botId];
    allLoginInfos.value = nextInfo;
  }

  async function loginCall(auth: AuthPayload): Promise<AuthStorage> {
    const data = await ofetch<AuthResponse>(`${auth.url}${APIBASE}/token/login`, {
      method: 'POST',
      body: {},
      credentials: 'include',
      headers: { Authorization: basicAuthHeader(auth.username, auth.password) },
    });
    if (data.access_token && data.refresh_token) {
      const obj: AuthStorage = {
        botName: auth.botName,
        apiUrl: auth.url,
        username: auth.username,
        accessToken: data.access_token || '',
        refreshToken: data.refresh_token || '',
        autoRefresh: true,
      };
      return obj;
    }
    return Promise.reject('login failed');
  }

  async function login(auth: AuthPayload) {
    const loginInfo = await loginCall(auth);
    const existing = allLoginInfos.value[botId];
    currentInfo.value = {
      ...loginInfo,
      sortId: existing?.sortId,
    };
  }

  // Shared across concurrent 401s so that an expired access token triggers only one refresh call.
  let refreshInFlight: Promise<string> | null = null;

  async function doRefreshToken(): Promise<string> {
    console.log('Refreshing token...');
    const token = currentInfo.value.refreshToken;
    try {
      const data = await ofetch<AuthResponse>(
        `${currentInfo.value.apiUrl}${APIBASE}/token/refresh`,
        {
          method: 'POST',
          body: {},
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!data.access_token) {
        throw new Error('No access token received');
      }
      mergeLoginInfo({ accessToken: data.access_token });
      return data.access_token;
    } catch (err) {
      console.error(err);
      if (isApiError(err)) {
        if (err.status === 401) {
          console.log('Refresh token did not refresh.');
          setRefreshTokenExpired();
        } else if (err.status === 500 || err.status === 404) {
          console.log('Bot seems to be offline... - retrying later');
        }
      }
      throw err;
    }
  }

  function refreshToken(): Promise<string> {
    if (!refreshInFlight) {
      refreshInFlight = doRefreshToken().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  return {
    updateBot,
    getLoginInfo,
    autoRefresh,
    accessToken,
    logout,
    login,
    refreshToken,
    baseUrl,
    baseWsUrl,
  };
}
