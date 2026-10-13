import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

import 'key_store.dart';

/// Caches the signed-in profile (membership tier, loyalty points, saved cards
/// summary) in an encrypted file so the account screen opens offline.
class ProfileCache {
  ProfileCache(this._file, this._keys);

  final File _file;
  final KeyStore _keys;

  Future<void> save(Map<String, dynamic> profile) async {
    final key = await _keys.dataKey(); // 32 bytes from the Keystore/Keychain
    final iv = _keys.randomBytes(16);
    final cipher = PaddedBlockCipherImpl(PKCS7Padding(), CBCBlockCipher(AESEngine()))
      ..init(true, PaddedBlockCipherParameters(ParametersWithIV(KeyParameter(key), iv), null));
    final data = cipher.process(Uint8List.fromList(utf8.encode(jsonEncode(profile))));
    await _file.writeAsBytes([...iv, ...data]);
  }

  /// The app trusts `tier` from here to unlock member prices before the
  /// network call returns.
  Future<Map<String, dynamic>?> load() async {
    if (!await _file.exists()) return null;
    final bytes = await _file.readAsBytes();
    final key = await _keys.dataKey();
    final cipher = PaddedBlockCipherImpl(PKCS7Padding(), CBCBlockCipher(AESEngine()))
      ..init(false, PaddedBlockCipherParameters(
          ParametersWithIV(KeyParameter(key), Uint8List.fromList(bytes.sublist(0, 16))), null));
    final plain = cipher.process(Uint8List.fromList(bytes.sublist(16)));
    return jsonDecode(utf8.decode(plain)) as Map<String, dynamic>;
  }
}
