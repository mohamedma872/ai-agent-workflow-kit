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
  /// Anything it cannot parse is omitted from the log, never logged raw.
  static String _redact(Object? data) {
    if (data == null) return '';
    Object? parsed;
    if (data is Map || data is List) {
      parsed = data;
    } else if (data is String && data.trimLeft().startsWith(RegExp(r'[{\[]'))) {
      try {
        parsed = jsonDecode(data);
      } on FormatException {
        return '[body omitted]';
      }
    } else if (data is String && data.contains('=')) {
      parsed = Uri.splitQueryString(data);
    } else if (data is FormData) {
      parsed = {for (final f in data.fields) f.key: f.value};
    }
    if (parsed == null) return '[body omitted]';
    return jsonEncode(_scrub(parsed));
  }

  /// Redacts sensitive keys at any depth.
  static Object? _scrub(Object? value) {
    if (value is Map) {
      return {
        for (final e in value.entries)
          e.key.toString(): _keys.contains(e.key) ? '***' : _scrub(e.value),
      };
    }
    if (value is List) return [for (final v in value) _scrub(v)];
    return value;
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
