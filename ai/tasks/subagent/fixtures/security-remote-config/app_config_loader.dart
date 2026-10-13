import 'dart:convert';

import 'package:dio/dio.dart';

import 'app_config.dart';
import 'config_cache.dart';

/// Loads runtime configuration from the CDN at startup. Ops can change these
/// values without an app release.
class AppConfigLoader {
  AppConfigLoader(this._dio, this._cache);

  final Dio _dio;
  final ConfigCache _cache;

  static const _url = 'https://cdn.example-shop.com/mobile/appdata.json';

  Future<AppConfig> load() async {
    try {
      final res = await _dio.get<String>(_url);
      await _cache.write(res.data!);
      return AppConfig.fromJson(jsonDecode(res.data!) as Map<String, dynamic>);
    } catch (_) {
      final cached = await _cache.read();
      return AppConfig.fromJson(cached == null ? {} : jsonDecode(cached) as Map<String, dynamic>);
    }
  }
}

// AppConfig fields used by the app:
//   paymentPublicKey     -> passed to the card SDK; its prefix picks sandbox or live
//   storefrontHost       -> WebViews attach the user's bearer token to this host
//   oauthClientId        -> used for the password grant
//   minSupportedVersion  -> force-update screen
