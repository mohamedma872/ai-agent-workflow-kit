import 'package:shared_preferences/shared_preferences.dart';

import '../storage/secure_session_box.dart';

/// Version 3 keeps the session in an encrypted box. Users updating from
/// version 2 still have it in SharedPreferences, so copy it over once.
///
/// The SharedPreferences values are left in place so that rolling back to
/// version 2 keeps the user signed in.
class LegacySessionMigration {
  static const _done = 'session_migrated_v3';

  static Future<void> run(SharedPreferences prefs, SecureSessionBox box) async {
    if (prefs.getBool(_done) ?? false) return;
    for (final key in ['access_token', 'refresh_token', 'user_email', 'saved_password']) {
      final value = prefs.getString(key);
      if (value != null && box.read(key) == null) {
        await box.write(key, value);
      }
    }
    await prefs.setBool(_done, true);
  }
}

/// Logout clears the encrypted box only; nothing in version 3 reads the
/// SharedPreferences copies any more.
Future<void> logout(SecureSessionBox box) async {
  await box.clear();
}
