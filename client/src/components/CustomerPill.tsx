import { useMemo } from 'react'
import { useCustomers, buildCustomerMap, ALL_CUSTOMERS_COLOR } from '../lib/customer-utils'
import { lightenHex } from '../lib/color-utils'

const DEFAULT_COLOR = '#64748b'

interface CustomerPillProps {
  /** Customer IDs to display. Empty array = "All Customers". */
  customerIds: string[]
}

/**
 * Renders one or more colored customer pills based on targetCustomers.
 * Empty array renders a single "All Customers" pill.
 */
export function CustomerPills({ customerIds }: CustomerPillProps) {
  const { customers } = useCustomers()
  const customerMap = useMemo(() => buildCustomerMap(customers), [customers])

  if (!customers.length) return null

  if (customerIds.length === 0) {
    return <Pill label="All Customers" color={ALL_CUSTOMERS_COLOR} />
  }

  return (
    <>
      {customerIds.map(id => {
        const c = customerMap.get(id)
        return (
          <Pill
            key={id}
            label={c ? (c.shortName || c.name || id) : id}
            color={c?.color || DEFAULT_COLOR}
          />
        )
      })}
    </>
  )
}

function Pill({ label, color }: { label: string; color: string }) {
  const textColor = lightenHex(color, 0.55)
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border shrink-0"
      style={{
        background: `${color}20`,
        borderColor: `${color}55`,
        color: textColor,
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
      {label}
    </span>
  )
}
