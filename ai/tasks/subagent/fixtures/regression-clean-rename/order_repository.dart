// Behavior-preserving refactor review fixture. Both versions are shown; the
// branch claims no behavior change. Fake code, not from any real project.

// ===== BASE (merge base) =====
class OrderApi {
  Future<List<Order>> fetchOrders(int page) async {
    final res = await http.get(Uri.parse('$baseUrl/users/orders?currentPage=$page&pageSize=10'));
    if (res.statusCode != 200) throw FetchDataException(res.body);
    final list = (jsonDecode(res.body)['orders'] as List?) ?? [];
    return list.map((e) => Order.fromJson(e)).toList();
  }
}

// ===== HEAD (branch) =====
class OrderRemoteDataSource {
  OrderRemoteDataSource(this._client);
  final HttpClientPort _client;

  Future<List<Order>> getOrders({required int page}) async {
    final res = await _client.get('$baseUrl/users/orders', query: {'currentPage': '$page', 'pageSize': '10'});
    if (res.statusCode != 200) throw FetchDataException(res.body);
    final list = (jsonDecode(res.body)['orders'] as List?) ?? const [];
    return list.map((e) => Order.fromJson(e)).toList();
  }
}
