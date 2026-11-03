import { useQuery } from '@tanstack/react-query';
import {
  fetchVendorSettlements,
  fulfillmentErrorMessage,
  settlementStatusLabel,
  VENDOR_SETTLEMENTS_KEY,
} from '../lib/fulfillment.js';
import { formatINR } from '../lib/money.js';
import './orders.css';

/** What the vendor will be paid for each order, and where each payout stands. */
export default function VendorSettlementsPage() {
  const { data, error, isPending } = useQuery({
    queryKey: VENDOR_SETTLEMENTS_KEY,
    queryFn: fetchVendorSettlements,
  });
  return (
    <section>
      <h1>Payouts</h1>
      <p>
        You are paid after an order is delivered and its 7-day return window has ended. Refunds
        reduce the payout.
      </p>
      {isPending && <p>Loading…</p>}
      {error && <p role="alert">{fulfillmentErrorMessage(error)}</p>}
      {data?.length === 0 && <p>No payouts yet.</p>}
      {data?.length > 0 && (
        <div className="table-scroll">
          <table className="settlements">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Sales</th>
                <th scope="col">Commission</th>
                <th scope="col">Refunds</th>
                <th scope="col">Payout</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id}>
                  <th scope="row">{s.subOrderNumber}</th>
                  <td>{formatINR(s.grossPaise)}</td>
                  <td>−{formatINR(s.commissionPaise)}</td>
                  <td>
                    {s.refundAdjustmentPaise ? `−${formatINR(s.refundAdjustmentPaise)}` : '—'}
                  </td>
                  <td>
                    <strong>{formatINR(s.netPayoutPaise)}</strong>
                  </td>
                  <td>{settlementStatusLabel(s.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
