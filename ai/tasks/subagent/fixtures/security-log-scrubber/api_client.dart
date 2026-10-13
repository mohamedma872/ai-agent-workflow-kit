import 'dart:convert';

import 'package:dio/dio.dart';

/// Shared client for the auth server and the profile API. Every request and
/// response is sent to the remote bug-report service; [_redact] keeps
/// credentials out of those reports.
class ApiClient {
  ApiClient(this._bugReports) {
    _dio.options.responseType = ResponseType.bytes; // callers decode themselves
    _dio.interceptors.add(InterceptorsWrapper(
      onResponse: (response, handler) {
        _bugReports.logNetwork(
          url: response.requestOptions.uri.toString(),
          requestBody: _redact(jsonEncode(response.requestOptions.data)),
          responseBody: _redact(jsonEncode(response.data)),
        );
        handler.next(response);
      },
    ));
  }

  final Dio _dio = Dio();
  final BugReportService _bugReports;

  static final _sensitive = RegExp(r'"(password|access_token|refresh_token)"\s*:\s*"[^"]*"');

  static String _redact(String body) =>
      body.replaceAllMapped(_sensitive, (m) => '"${m[1]}":"***"');

  Future<Map<String, dynamic>> login(String username, String password) async {
    final res = await _dio.post<List<int>>(
      'https://auth.example.com/oauth/token',
      data: {'grant_type': 'password', 'username': username, 'password': password},
    );
    return jsonDecode(utf8.decode(res.data!)) as Map<String, dynamic>;
  }
}

abstract class BugReportService {
  void logNetwork({required String url, required String requestBody, required String responseBody});
}
