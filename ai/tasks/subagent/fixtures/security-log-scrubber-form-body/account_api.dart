import 'dart:convert';

import 'package:dio/dio.dart';

/// Account API. Every request through [_dio] is sent to the remote
/// bug-report service; [_redact] keeps credentials out of those reports.
class AccountApi {
  AccountApi(this._bugReports, this._baseUrl) {
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
  final String _baseUrl;

  static final _sensitive =
      RegExp(r'"(password|newPassword|token|access_token)"\s*:\s*"[^"]*"', caseSensitive: false);

  static String _redact(String body) =>
      body.replaceAllMapped(_sensitive, (m) => '"${m[1]}":"***"');

  /// Completes a reset started from the emailed link.
  Future<bool> resetPassword({required String resetToken, required String newPassword}) async {
    final form = Uri(queryParameters: {
      'token': resetToken,
      'newPassword': newPassword,
      'checkNewPassword': newPassword,
    }).query;
    final res = await _dio.post<void>(
      '$_baseUrl/users/resetPassword',
      data: form,
      options: Options(contentType: Headers.formUrlEncodedContentType),
    );
    return res.statusCode == 200;
  }

  Future<Map<String, dynamic>> profile(String accessToken) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '$_baseUrl/users/current',
      options: Options(headers: {'Authorization': 'Bearer $accessToken'}),
    );
    return res.data!;
  }
}

abstract class BugReportService {
  void logNetwork({required String url, required String requestBody});
}
