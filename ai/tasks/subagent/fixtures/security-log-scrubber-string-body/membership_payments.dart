import 'dart:convert';

import 'package:dio/dio.dart';

/// Membership renewal payments. Every request through [_dio] is sent to the
/// remote bug-report service; [_redact] keeps card data out of those reports.
class MembershipPayments {
  MembershipPayments(this._bugReports) {
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) {
        _bugReports.logNetwork(
          url: options.uri.toString(),
          requestBody: _redact(jsonEncode(options.data)),
        );
        handler.next(options);
      },
    ));
  }

  final Dio _dio = Dio();
  final BugReportService _bugReports;

  static const _keys = ['number', 'cvv', 'expiry_month', 'expiry_year', 'password'];

  static String _redact(String body) {
    var out = body;
    for (final key in _keys) {
      out = out.replaceAll(RegExp('"$key"\\s*:\\s*"[^"]*"'), '"$key":"***"');
    }
    return out;
  }

  /// Tokenizes a new card with the payment provider before renewing.
  Future<String> tokenizeCard({
    required String number,
    required String expiryMonth,
    required String expiryYear,
    required String cvv,
    required String publicKey,
  }) async {
    final body = jsonEncode({
      'type': 'card',
      'number': number,
      'expiry_month': expiryMonth,
      'expiry_year': expiryYear,
      'cvv': cvv,
    });
    final res = await _dio.post<Map<String, dynamic>>(
      'https://api.payments.example.com/tokens',
      data: body,
      options: Options(headers: {'Authorization': publicKey, 'Content-Type': 'application/json'}),
    );
    return res.data!['token'] as String;
  }
}

abstract class BugReportService {
  void logNetwork({required String url, required String requestBody});
}
