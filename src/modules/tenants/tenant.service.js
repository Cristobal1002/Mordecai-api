import { tenantRepository } from './tenant.repository.js';
import { sequelize } from '../../config/database.js';
import { TenantUser, User, TenantSubscription } from '../../models/index.js';
import { buildNewSubscriptionDefaults } from '../billing/billing-trial.service.js';
import { getAuthIdentity } from '../../utils/auth-identity.js';
import { userService } from '../users/user.service.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors/index.js';

const enforceSingleTenant = process.env.ENFORCE_SINGLE_TENANT !== 'false';

const requireTenantAdmin = async (tenantId, req) => {
  const identity = getAuthIdentity(req);
  if (!identity.sub) {
    throw new ForbiddenError('Unauthorized');
  }

  const user = await userService.ensureUserFromAuth(identity);
  const membership = await TenantUser.findOne({
    where: {
      tenantId,
      userId: user.id,
      status: 'active',
    },
  });

  if (!membership) {
    throw new ForbiddenError('You are not a member of this tenant.');
  }

  if (!['owner', 'admin'].includes(membership.role)) {
    throw new ForbiddenError('Admin privileges required.');
  }

  return { user, membership };
};

const requireTenantOwner = async (tenantId, req) => {
  const identity = getAuthIdentity(req);
  if (!identity.sub) {
    throw new ForbiddenError('Unauthorized');
  }

  const user = await userService.ensureUserFromAuth(identity);
  const membership = await TenantUser.findOne({
    where: {
      tenantId,
      userId: user.id,
      status: 'active',
    },
  });

  if (!membership) {
    throw new ForbiddenError('You are not a member of this tenant.');
  }

  if (membership.role !== 'owner') {
    throw new ForbiddenError('Owner privileges required.');
  }

  return { user, membership };
};

export const tenantService = {
  create: async (data, req) => {
    const identity = getAuthIdentity(req);
    if (!identity.sub || !identity.email) {
      throw new ForbiddenError('Unauthorized');
    }

    const enrichedIdentity = {
      ...identity,
      ...(data.fullName && { fullName: data.fullName.trim() }),
      ...(data.phone !== undefined &&
        data.phone !== null && {
          phone: data.phone ? String(data.phone).trim() : null,
        }),
    };

    return await sequelize.transaction(async (transaction) => {
      const user = await userService.ensureUserFromAuth(enrichedIdentity, transaction);

      if (enforceSingleTenant) {
        const existing = await userService.countActiveMemberships(user.id, transaction);
        if (existing > 0) {
          throw new ConflictError('User already belongs to a tenant.');
        }
      }

      const { name, fullName, phone, ...rest } = data;
      const tenant = await tenantRepository.create(
        {
          name,
          ...rest,
          status: 'active',
        },
        transaction
      );

      await TenantUser.create(
        {
          tenantId: tenant.id,
          userId: user.id,
          role: 'owner',
          status: 'active',
        },
        { transaction }
      );

      await TenantSubscription.create(
        {
          tenantId: tenant.id,
          ...buildNewSubscriptionDefaults(),
        },
        { transaction }
      );

      return tenant;
    });
  },

  requireTenantAdmin: (tenantId, req) => requireTenantAdmin(tenantId, req),
  requireTenantOwner: (tenantId, req) => requireTenantOwner(tenantId, req),

  getAdminSnapshot: async (tenantId, req) => {
    await requireTenantAdmin(tenantId, req);

    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) {
      throw new NotFoundError('Tenant');
    }

    const members = await TenantUser.findAll({
      where: { tenantId },
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'email', 'fullName', 'phone', 'status', 'createdAt', 'updatedAt'],
        },
      ],
      order: [['created_at', 'ASC']],
    });

    const activeMembers = members.filter((member) => member.status === 'active').length;
    const adminMembers = members.filter((member) => ['owner', 'admin'].includes(member.role)).length;

    return {
      tenant,
      members,
      stats: {
        totalMembers: members.length,
        activeMembers,
        adminMembers,
      },
    };
  },

  update: async (tenantId, data, req) => {
    await requireTenantAdmin(tenantId, req);

    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) {
      throw new NotFoundError('Tenant');
    }

    const updates = {};
    if (data.name !== undefined) updates.name = data.name.trim();
    if (data.timezone !== undefined) updates.timezone = data.timezone?.trim() || 'America/New_York';
    if (data.settings !== undefined) updates.settings = data.settings;

    if (Object.keys(updates).length === 0) return tenant;

    await tenant.update(updates);
    return tenant;
  },
};
