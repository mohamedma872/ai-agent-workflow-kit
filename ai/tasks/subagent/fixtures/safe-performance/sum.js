'use strict';
// Sums order totals once per render of the cart summary; carts are capped at 50 items by the API.
function cartTotal(items) {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += items[i].unitPrice * items[i].quantity;
  }
  return Math.round(total * 100) / 100;
}

module.exports = { cartTotal };
