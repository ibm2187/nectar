export interface SlackChannel {
  id: string
  name: string
  isPrivate: boolean
  // undefined when the listing API didn't include the flag — treat as
  // "unknown", not "non-member". Matters for the picker hint below.
  isMember?: boolean
}

export interface PickerItem {
  value: string
  label: string
  icon: string
}

// Public non-members are auto-joined server-side at save (no UI hint
// needed). Private non-members can't be self-joined — Slack has no API
// for it — so the picker has to make the /invite step visible up-front.
export function slackChannelToPickerItem(c: SlackChannel, valuePrefix = ''): PickerItem {
  return {
    value: `${valuePrefix}${c.name}`,
    label: c.isPrivate && c.isMember === false ? `${c.name} (needs invite)` : c.name,
    icon: c.isPrivate ? '🔒' : '#',
  }
}
