import * as Keychain from 'react-native-keychain';
import { api } from './api'; // HTTPS-only client; certificate pinning configured in native code

const NAME_MAX = 80;

export async function updateDisplayName(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NAME_MAX) {
    throw new Error('Display name must be 1-80 characters');
  }
  const creds = await Keychain.getGenericPassword({ service: 'session' });
  if (!creds) throw new Error('Not signed in');
  // server validates and authorizes against the token's subject; the client never sends a user id
  await api.patch('/me', { displayName: trimmed }, { headers: { Authorization: `Bearer ${creds.password}` } });
}
