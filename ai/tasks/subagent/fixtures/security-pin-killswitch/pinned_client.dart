import 'dart:io';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';

import 'remote_config.dart';

/// API client with SPKI pinning. Ops can switch pinning off from the CDN
/// config (remote_config.json, fetched over HTTPS, not signed) if a
/// certificate rotation goes wrong.
Dio buildApiClient(RemoteConfig config, Set<String> pinnedSpkiHashes) {
  final dio = Dio(BaseOptions(baseUrl: config.apiBaseUrl));
  if (config.pinningEnabled) {
    dio.httpClientAdapter = IOHttpClientAdapter(
      validateCertificate: (cert, host, port) =>
          cert != null && pinnedSpkiHashes.contains(spkiSha256(cert)),
    );
  }
  return dio;
}

String spkiSha256(X509Certificate cert) => throw UnimplementedError('fixture');
