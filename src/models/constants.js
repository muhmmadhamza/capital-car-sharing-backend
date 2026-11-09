// Central enums shared by services/validators. Keep in sync with the CHECK constraints in the migrations.
module.exports = {
  ROLES: ['customer', 'partner', 'admin'],
  USER_STATUS: ['active', 'suspended'],
  PARTNER_STATUS: ['pending', 'active', 'suspended'],
  CAR_STATUS: ['active', 'inactive'],
  CAR_APPROVAL_STATUS: ['pending', 'approved', 'rejected', 'suspended'],
  AVAILABILITY_STATUS: ['available', 'unavailable', 'booked'],
  RESERVATION_STATUS: ['pending', 'confirmed', 'completed', 'cancelled', 'rejected'],
  // Statuses that hold a car for its dates. Cancelled / rejected / completed bookings free them.
  // Every availability, search and deletion check uses this ONE list (see HOLDING_SQL).
  RESERVATION_HOLDING_STATUS: ['pending', 'confirmed'],
};
