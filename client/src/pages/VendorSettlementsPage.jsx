import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  EmptyState,
  ErrorState,
  PageHeader,
  PageLoading,
  StatusBadge,
  Table,
  TBody,
  Td,
  Th,
  THead,
} from '../components/ui';
import {
  fetchVendorSettlements,
  fulfillmentErrorMessage,
  settlementStatusLabel,
  VENDOR_SETTLEMENTS_KEY,
} from '../lib/fulfillment.js';
import { formatINR } from '../lib/money.js';

/** What the vendor will be paid for each order, and where each payout stands. */
export default function VendorSettlementsPage() {
  const { data, error, isPending } = useQuery({
    queryKey: VENDOR_SETTLEMENTS_KEY,
    queryFn: fetchVendorSettlements,
  });
  return (
    <>
      <PageHeader title="Payouts" />
      <Alert tone="info" className="mb-6">
        You are paid after an order is delivered and its 7-day return window has ended. Refunds
        reduce the payout.
      </Alert>
      {isPending && <PageLoading />}
      {error && <ErrorState message={fulfillmentErrorMessage(error)} />}
      {data?.length === 0 && (
        <EmptyState
          icon="wallet"
          title="No payouts yet"
          description="Payouts appear here once you have orders."
        />
      )}
      {data?.length > 0 && (
        <Table label="Payouts">
          <THead>
            <Th>Order</Th>
            <Th num>Sales</Th>
            <Th num>Commission</Th>
            <Th num>Refunds</Th>
            <Th num>Payout</Th>
            <Th>Status</Th>
          </THead>
          <TBody>
            {data.map((s) => (
              <tr key={s.id}>
                <Td header>{s.subOrderNumber}</Td>
                <Td num>{formatINR(s.grossPaise)}</Td>
                <Td num>{`\u2212${formatINR(s.commissionPaise)}`}</Td>
                <Td num>
                  {s.refundAdjustmentPaise
                    ? `\u2212${formatINR(s.refundAdjustmentPaise)}`
                    : '\u2014'}
                </Td>
                <Td num className="font-semibold text-slate-900">
                  {formatINR(s.netPayoutPaise)}
                </Td>
                <Td>
                  <StatusBadge status={s.status} label={settlementStatusLabel(s.status)} />
                </Td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
    </>
  );
}
