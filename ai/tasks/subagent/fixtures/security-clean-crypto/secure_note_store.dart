import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Stores the delivery note draft encrypted with AES-GCM. The data key is
/// generated once and kept in the Keychain/Keystore, never on disk.
class SecureNoteStore {
  SecureNoteStore(this._storage, this._files);

  final FlutterSecureStorage _storage;
  final NoteFiles _files;
  final _algorithm = AesGcm.with256bits();

  static const _keyName = 'note_data_key';
  static const _ios = IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device);

  Future<SecretKey>? _keyFuture;

  /// Created once per store; concurrent first calls share the same future.
  Future<SecretKey> _key() => _keyFuture ??= _loadOrCreateKey();

  Future<SecretKey> _loadOrCreateKey() async {
    final existing = await _storage.read(key: _keyName, iOptions: _ios);
    if (existing != null) return SecretKey(base64Decode(existing));
    final key = await _algorithm.newSecretKey();
    await _storage.write(key: _keyName, value: base64Encode(await key.extractBytes()), iOptions: _ios);
    return key;
  }

  Future<void> save(String note) async {
    final box = await _algorithm.encrypt(utf8.encode(note), secretKey: await _key());
    await _files.write(box.concatenation());
  }

  /// Throws SecretBoxAuthenticationError if the file was modified; the caller
  /// discards the draft.
  Future<String?> load() async {
    final bytes = await _files.read();
    if (bytes == null) return null;
    final box = SecretBox.fromConcatenation(bytes, nonceLength: 12, macLength: 16);
    return utf8.decode(await _algorithm.decrypt(box, secretKey: await _key()));
  }
}
