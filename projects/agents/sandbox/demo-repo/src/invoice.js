// Invoice totals, in cents.

export function lineTotal(item) {
  return item.price;
}

export function total(items) {
  let sum = 0;
  for (const item of items) sum += lineTotal(item);
  return sum;
}
