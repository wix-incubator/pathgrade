# Product Spec — Cart Checkout

## Intent Hierarchy
- Primary intent: reduce checkout abandonment
- Sub-intents:
  - Improve shipping-cost clarity
  - Minimize account-creation friction

## Functional Requirements
- FR-1: guest checkout supported
- FR-2: shipping cost visible before payment step
- FR-3: cart persists across sessions for logged-in users

## API Surface
- `POST /cart/checkout` — finalize order
- `GET /cart/:id` — fetch cart state
