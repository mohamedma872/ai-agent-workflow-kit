import AsyncStorage from '@react-native-async-storage/async-storage';

type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };

// Persist the session so the user stays signed in across app restarts.
export async function saveSession(tokens: Tokens): Promise<void> {
  await AsyncStorage.setItem('session', JSON.stringify(tokens));
}

export async function loadSession(): Promise<Tokens | null> {
  const raw = await AsyncStorage.getItem('session');
  return raw ? (JSON.parse(raw) as Tokens) : null;
}

export async function clearSession(): Promise<void> {
  await AsyncStorage.removeItem('session');
}
