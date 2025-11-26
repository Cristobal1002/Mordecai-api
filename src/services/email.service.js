import nodemailer from 'nodemailer';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { loadAndRenderTemplate } from '../utils/template-loader.js';

class EmailService {
  constructor() {
    this.transporter = null;
    this.enabled = config.email.enabled;
    
    if (this.enabled) {
      this.initializeTransporter();
    }
  }
  
  /**
   * Initialize Nodemailer transporter with Gmail configuration
   */
  initializeTransporter() {
    try {
      // Validate required email configuration
      if (!config.email.auth.user || !config.email.auth.pass) {
        logger.warn('Email configuration incomplete. Email service disabled.');
        this.enabled = false;
        return;
      }
      
      this.transporter = nodemailer.createTransport({
        service: config.email.service,
        host: config.email.host,
        port: config.email.port,
        secure: config.email.secure, // true for 465, false for other ports
        auth: {
          user: config.email.auth.user,
          pass: config.email.auth.pass, // Gmail App Password
        },
      });
      
      logger.info('Email service initialized successfully');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize email service');
      this.enabled = false;
    }
  }
  
  /**
   * Verify email transporter connection
   */
  async verifyConnection() {
    if (!this.enabled || !this.transporter) {
      return false;
    }
    
    try {
      await this.transporter.verify();
      logger.info('Email service connection verified');
      return true;
    } catch (error) {
      logger.error({ error }, 'Email service connection verification failed');
      return false;
    }
  }
  
  /**
   * Send organization invitation email
   * @param {Object} options - Email options
   * @param {string} options.to - Recipient email address
   * @param {string} options.invitationLink - Firebase invitation link
   * @param {string} options.organizationName - Organization name
   * @param {string} options.inviterName - Name of the person sending the invitation
   * @param {string} options.role - Role assigned to the user
   * @param {Date} options.expiresAt - Invitation expiration date
   * @param {string} options.primaryColor - Organization primary color (hex)
   * @param {string} options.secondaryColor - Organization secondary color (hex)
   * @param {string} options.logoUrl - Organization logo URL (optional)
   * @returns {Promise<Object>} - Nodemailer result
   */
  async sendInvitationEmail({
    to,
    invitationLink,
    organizationName,
    inviterName,
    role,
    expiresAt,
    primaryColor = '#007bff',
    secondaryColor = '#6c757d',
    logoUrl = null,
  }) {
    if (!this.enabled || !this.transporter) {
      logger.warn('Email service is disabled. Skipping invitation email.');
      return { sent: false, reason: 'Email service disabled' };
    }
    
    try {
      // Format expiration date
      const expirationDate = new Date(expiresAt);
      const formattedDate = expirationDate.toLocaleDateString('es-ES', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      
      // Format role name
      const roleNames = {
        owner: 'Propietario',
        admin: 'Administrador',
        manager: 'Gerente',
        employee: 'Empleado',
        viewer: 'Visualizador',
        guest: 'Invitado',
      };
      const formattedRole = roleNames[role] || role;
      
      // Generate logo HTML if logoUrl is provided
      const logoImg = logoUrl 
        ? `<img src="${logoUrl}" alt="${organizationName}" class="logo">`
        : '';
      
      // Prepare template data
      const templateData = {
        organizationName: organizationName || 'Organización',
        inviterName: inviterName || 'Un administrador',
        role: formattedRole,
        invitationLink,
        expiresAt: formattedDate,
        primaryColor,
        secondaryColor,
        logoUrl: logoUrl || '',
        logoImg,
        currentYear: new Date().getFullYear().toString(),
      };
      
      // Load and render HTML template
      const htmlContent = await loadAndRenderTemplate('invitation', templateData);
      
      // Email options
      const mailOptions = {
        from: `"${config.email.fromName}" <${config.email.from}>`,
        to,
        subject: `Invitación a ${organizationName}`,
        html: htmlContent,
        // Plain text version (fallback)
        text: `
Hola,

${inviterName} te ha invitado a unirte a ${organizationName}.

Organización: ${organizationName}
Rol asignado: ${formattedRole}
Invitado por: ${inviterName}

Para aceptar la invitación, haz clic en el siguiente enlace:
${invitationLink}

Este enlace expirará el ${formattedDate}.

Este es un correo automático, por favor no respondas a este mensaje.
        `.trim(),
      };
      
      // Send email
      const info = await this.transporter.sendMail(mailOptions);
      
      logger.info({
        messageId: info.messageId,
        to,
        organizationName,
      }, 'Invitation email sent successfully');
      
      return {
        sent: true,
        messageId: info.messageId,
        response: info.response,
      };
    } catch (error) {
      logger.error({
        error,
        to,
        organizationName,
      }, 'Failed to send invitation email');
      
      return {
        sent: false,
        error: error.message,
      };
    }
  }
  
  /**
   * Send a generic email (for future use)
   * @param {Object} options - Email options
   * @returns {Promise<Object>} - Nodemailer result
   */
  async sendEmail({ to, subject, html, text }) {
    if (!this.enabled || !this.transporter) {
      logger.warn('Email service is disabled. Skipping email.');
      return { sent: false, reason: 'Email service disabled' };
    }
    
    try {
      const mailOptions = {
        from: `"${config.email.fromName}" <${config.email.from}>`,
        to,
        subject,
        html,
        text,
      };
      
      const info = await this.transporter.sendMail(mailOptions);
      
      logger.info({ messageId: info.messageId, to, subject }, 'Email sent successfully');
      
      return {
        sent: true,
        messageId: info.messageId,
        response: info.response,
      };
    } catch (error) {
      logger.error({ error, to, subject }, 'Failed to send email');
      
      return {
        sent: false,
        error: error.message,
      };
    }
  }
}

// Export singleton instance
export const emailService = new EmailService();


