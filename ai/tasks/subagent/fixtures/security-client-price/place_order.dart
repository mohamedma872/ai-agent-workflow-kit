import 'package:dio/dio.dart';

import 'cart.dart';

/// Places the order after the card SDK reports a successful authorization.
/// The Dio instance has a RetryInterceptor (3 attempts on timeout or 5xx).
class PlaceOrder {
  PlaceOrder(this._dio);

  final Dio _dio;

  Future<String> call(Cart cart, {required String paymentReference}) async {
    final subtotal = cart.items.fold<double>(0, (sum, i) => sum + i.unitPrice * i.quantity);
    final discount = cart.memberTier == 'gold' ? subtotal * 0.10 : 0.0;
    final total = subtotal - discount + cart.shippingFee;

    final res = await _dio.post<Map<String, dynamic>>(
      '/orders',
      data: {
        'cartId': cart.id,
        'items': [for (final i in cart.items) {'sku': i.sku, 'qty': i.quantity, 'price': i.unitPrice}],
        'discount': discount,
        'total': total,
        'paymentReference': paymentReference,
        'paymentStatus': 'AUTHORIZED',
      },
    );
    return res.data!['orderId'] as String;
  }
}
