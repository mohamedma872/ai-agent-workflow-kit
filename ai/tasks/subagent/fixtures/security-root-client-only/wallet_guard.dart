import 'package:dio/dio.dart';
import 'package:safe_device/safe_device.dart';

/// Wallet top-ups and saved-card payments are only allowed on safe devices.
/// The backend skips its own fraud checks when `deviceTrusted` is true.
class WalletGuard {
  WalletGuard(this._dio);

  final Dio _dio;

  Future<void> topUp(String walletId, double amount) async {
    final rooted = await SafeDevice.isJailBroken;
    if (rooted) {
      throw StateError('Top-up is not available on this device');
    }
    await _dio.post('/wallet/$walletId/topup', data: {
      'amount': amount,
      'deviceTrusted': true,
    });
  }
}
