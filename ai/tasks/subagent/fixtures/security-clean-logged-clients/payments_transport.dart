import 'dart:convert';

import 'package:dio/dio.dart';

/// Two clients: [logged] reports traffic to the bug-report service for
/// catalogue and cart calls; [unlogged] carries card tokenization and
/// password changes and has no logging interceptor.
class PaymentsTransport {
  PaymentsTransport(this._bugReports) {
    logged.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) {
        _bugReports.logNetwork(url: options.uri.toString(), requestBody: _redact(options.data));
        handler.next(options);
      },
    ));
  }

  final Dio logged = Dio();
  final Dio unlogged = Dio();
  final BugReportService _bugReports;

  static const _keys = {'password', 'newPassword', 'token', 'number', 'cvv', 'email', 'mobile'};

  /// Normalizes every body shape to a map before redacting, so pre-encoded
  /// JSON strings, form strings and maps are all scrubbed the same way.
  static String _redact(Object? data) {
    Map<String, dynamic>? map;
    if (data is Map) {
      map = Map<String, dynamic>.from(data);
    } else if (data is String && data.trimLeft().startsWith('{')) {
      map = (jsonDecode(data) as Map).cast<String, dynamic>();
    } else if (data is String && data.contains('=')) {
      map = Uri.splitQueryString(data);
    } else if (data is FormData) {
      map = {for (final f in data.fields) f.key: f.value};
    }
    if (map == null) return data == null ? '' : '[body omitted]';
    return jsonEncode({for (final e in map.entries) e.key: _keys.contains(e.key) ? '***' : e.value});
  }

  Future<String> tokenizeCard(Map<String, String> card, String publicKey) async {
    final res = await unlogged.post<Map<String, dynamic>>(
      'https://api.payments.example.com/tokens',
      data: jsonEncode({'type': 'card', ...card}),
      options: Options(headers: {'Authorization': publicKey}),
    );
    return res.data!['token'] as String;
  }

  Future<void> addToCart(String cartId, String sku, int qty) =>
      logged.post<void>('https://shop.example.com/carts/$cartId/entries', data: {'sku': sku, 'qty': qty});
}

abstract class BugReportService {
  void logNetwork({required String url, required String requestBody});
}
