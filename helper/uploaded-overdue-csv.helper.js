/*
 * Module Imports
 * */
const mongoose = require('mongoose');
const UploadedOverdueCsv = mongoose.model('uploaded-overdue-csv');
const ClientUser = mongoose.model('client-user');
const Client = mongoose.model('client');

/*
 * Local Imports
 * */
const Logger = require('./../services/logger');
const { addAuditLog } = require('./audit-log.helper');
const { addNotification } = require('./notification.helper');
const { sendNotification } = require('./socket.helper');

const addUploadedOverdueCsv = async ({ submittedById, submittedByType }) => {
  try {
    const uploadedOverdueCsv = await UploadedOverdueCsv.create({
      submittedById,
      submittedByType,
    });

    Logger.log.info('Uploaded Overdue CSV added');

    // add log and send notification
    addAuditLog({
      entityType: 'uploaded-overdue-csv',
      entityRefId: uploadedOverdueCsv._id,
      actionType: 'add',
      userType: submittedByType,
      userRefId: submittedById,
      logDescription: 'Overdue CSV has been uploaded successfully',
    });

    if (submittedByType === 'client-user') {
      const client = await ClientUser.findById(submittedById)
        .populate('clientId', 'riskAnalystId serviceManagerId name')
        .select('name')
        .lean();

      if (client.clientId.riskAnalystId) {
        const notification = await addNotification({
          userId: client.clientId.riskAnalystId,
          userType: 'user',
          description: `A new upload has been completed by ${client.name} at ${client.clientId.name} via the Bulk Upload form. This data is already added to the system. Review the uploaded data by clicking on this message.`,
          entityId: client.clientId._id,
          entityType: 'uploaded-overdue-csv',
          csvId: uploadedOverdueCsv._id,
        });

        sendNotification({
          notificationObj: {
            type: 'OVERDUE_BULKUPLOADED',
            data: notification,
          },
          type: notification.userType,
          userId: notification.userId,
        });
      }

      /*if (client.clientId.serviceManagerId) {
        const notification = await addNotification({
          userId: client.clientId.serviceManagerId,
          userType: 'user',
          description: `New overdue csv has been uploaded by client ${client.clientId.name}`,
          entityId: client.clientId._id,
          entityType: 'uploaded-overdue-csv',
          csvId: uploadedOverdueCsv._id,
        });

        sendNotification({
          notificationObj: {
            type: 'OVERDUE_BULKUPLOADED',
            data: notification,
          },
          type: notification.userType,
          userId: notification.userId,
        });
      }*/
    }

    return uploadedOverdueCsv;
  } catch (e) {
    Logger.log.error(`Error occurred in add overdue `, e.message || e);
  }
};

module.exports = {
  addUploadedOverdueCsv,
};
