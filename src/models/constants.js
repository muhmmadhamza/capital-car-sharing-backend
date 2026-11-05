// Central enums shared by services/validators. Keep in sync with the CHECK constraints in the migrations.
module.exports = {
  ROLES: ['customer', 'partner', 'admin'],
  USER_STATUS: ['active', 'suspended'],
  PARTNER_STATUS: ['pending', 'active', 'suspended'],
  CAR_STATUS: ['active', 'inactive'],
  CAR_APPROVAL_STATUS: ['pending', 'approved', 'rejected', 'suspended'],
  AVAILABILITY_STATUS: ['available', 'unavailable', 'booked'],
  RESERVATION_STATUS: ['upcoming', 'active', 'completed', 'cancelled'],
};
