/*
 * Module Imports
 * */
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');
const Overdue = mongoose.model('overdue');
const Client = mongoose.model('client');
// const ClientDebtor = mongoose.model('client-debtor');
const Debtor = mongoose.model('debtor');
const Insurer = mongoose.model('insurer');
// const DebtorDirector = mongoose.model('debtor-director');
// const Note = mongoose.model('note');
const Organization = mongoose.model('organization');
// const { numberWithCommas } = require('./report.helper');
// const { checkDirectorsOfDebtor } = require('./debtor.helper');
// const { getEntityDetailsByBusinessNumber } = require('./abr.helper');
// const { checkForAutomation } = require('./overdue.helper');
const {
  // countryList,
  overdueTypes,
  // companyEntityType,
} = require('../static-files/staticData.json');

const ImportOverdueDump = mongoose.model('import-overdue-dump');
const { addNotification } = require('./notification.helper');
const { sendNotification } = require('./socket.helper');
const { addAuditLog } = require('./audit-log.helper');
const Logger = require('../services/logger');

const readExcelFile = async (fileBuffer) => {
  try {
    const workbook = new ExcelJS.Workbook();
    // await workbook.xlsx.readFile('./Overdues_Import.xlsx');
    await workbook.xlsx.load(fileBuffer);
    const overdues = [];
    const unProcessedOverdues = [];
    const overdueHeaders = {
      'Debtor ACN *': { columnName: null },
      'Debtor Entity Name *': { columnName: null },
      'Date of Oldest Invoice *': { columnName: null },
      'Overdue Type *': { columnName: null },
      'Insurer Name *': { columnName: null },
      'Current Outstanding Amount *': { columnName: null },
      '30 Days Outstanding Amount *': { columnName: null },
      '60 Days Outstanding Amount *': { columnName: null },
      '90 Days Outstanding Amount *': { columnName: null },
      '90+ Days Outstanding Amount *': { columnName: null },
      'Total Outstanding Amount': { columnName: null },
      'Client Comment': { columnName: null },
    };

    const overdueWorksheet = workbook.getWorksheet('Overdues');
    if (!overdueWorksheet) {
      return {
        isImportCompleted: false,
        reasonForInCompletion: 'Missing Overdues worksheet',
      };
    }
    for (let i = 0; i < Object.keys(overdueHeaders).length; i++) {
      const column = overdueWorksheet.model.rows[0].cells.find(
        (cell) => cell.value === Object.keys(overdueHeaders)[i],
      );
      if (!column || (column && !column.address)) {
        return {
          isImportCompleted: false,
          reasonForInCompletion: 'Missing Headers from Overdue sheet',
        };
      }
      overdueHeaders[
        Object.keys(overdueHeaders)[i]
      ].columnName = column.address.substr(0, column.address.length - 1);
    }
    overdueLoop: for (let i = 1; i < overdueWorksheet.model.rows.length; i++) {
      if (
        overdueWorksheet.model.rows[i].cells &&
        overdueWorksheet.model.rows[i].cells.length !== 0
      ) {
        const rowNumber = overdueWorksheet.model.rows[i].number;
        const overdue = {
          acn: overdueWorksheet.model.rows[i].cells.find(
            (c) =>
              c.address ===
              `${overdueHeaders['Debtor ACN *']['columnName']}${rowNumber}`,
          )?.value,
          entityName: overdueWorksheet.model.rows[i].cells.find(
            (c) =>
              c.address ===
              `${overdueHeaders['Debtor Entity Name *']['columnName']}${rowNumber}`,
          )?.value,
          dateOfInvoice: overdueWorksheet.model.rows[i].cells.find(
            (c) =>
              c.address ===
              `${overdueHeaders['Date of Oldest Invoice *']['columnName']}${rowNumber}`,
          )?.value,
          overdueType: overdueWorksheet.model.rows[i].cells.find(
            (c) =>
              c.address ===
              `${overdueHeaders['Overdue Type *']['columnName']}${rowNumber}`,
          )?.value,
          insurerId: overdueWorksheet.model.rows[i].cells.find(
            (c) =>
              c.address ===
              `${overdueHeaders['Insurer Name *']['columnName']}${rowNumber}`,
          )?.value,
          currentAmount: overdueWorksheet.model.rows[i].cells.find(
            (c) =>
              c.address ===
              `${overdueHeaders['Current Outstanding Amount *']['columnName']}${rowNumber}`,
          )?.value ?? 0,
          thirtyDaysAmount: overdueWorksheet.model.rows[i].cells.find(
            (c) =>
              c.address ===
              `${overdueHeaders['30 Days Outstanding Amount *']['columnName']}${rowNumber}`,
          )?.value ?? 0,
          sixtyDaysAmount: overdueWorksheet.model.rows[i].cells.find(
            (c) =>
              c.address ===
              `${overdueHeaders['60 Days Outstanding Amount *']['columnName']}${rowNumber}`,
          )?.value ?? 0,
          ninetyDaysAmount: overdueWorksheet.model.rows[i].cells.find(
            (c) =>
              c.address ===
              `${overdueHeaders['90 Days Outstanding Amount *']['columnName']}${rowNumber}`,
          )?.value ?? 0,
          ninetyPlusDaysAmount: overdueWorksheet.model.rows[i].cells.find(
            (c) =>
              c.address ===
              `${overdueHeaders['90+ Days Outstanding Amount *']['columnName']}${rowNumber}`,
          )?.value ?? 0,
          clientComment: overdueWorksheet.model.rows[i].cells.find(
            (c) =>
              c.address ===
              `${overdueHeaders['Client Comment']['columnName']}${rowNumber}`,
          )?.value,
        };
        outstandingFormula = overdueWorksheet.model.rows[i].cells.find(
          (c) =>
            c.address ===
            `${overdueHeaders['Total Outstanding Amount']['columnName']}${rowNumber}`,
        )?.formula;
        if (overdue.overdueType) {
          overdue.overdueType = overdueTypes.find(
            (c) => c.name === overdue.overdueType,
          )?._id;
        }
        if (
          !overdue.overdueType
        ) {
          unProcessedOverdues.push({
            ...overdue,
            reason: 'Invalid Entity Type found.',
          });
          continue;
        }
        if (
          outstandingFormula !==
          `F${rowNumber}+G${rowNumber}+H${rowNumber}+I${rowNumber}+J${rowNumber}`
        ) {
          unProcessedOverdues.push({
            ...overdue,
            reason: 'Invalid Outstanding Amount.',
          });
          continue;
        }
        overdue.outstandingAmount =
          overdue.currentAmount +
          overdue.thirtyDaysAmount +
          overdue.sixtyDaysAmount +
          overdue.ninetyDaysAmount +
          overdue.ninetyPlusDaysAmount;
        /*Validation on Mandatory fields start*/
        if (
          !overdue.acn
        ) {
          unProcessedOverdues.push({
            ...overdue,
            reason:
              'Missing Debtor ACN',
          });
          continue;
        }
        if (
          !overdue.entityName
        ) {
          unProcessedOverdues.push({
            ...overdue,
            reason:
              'Missing Debtor Entity Name.',
          });
          continue;
        }
        if (
          !overdue.dateOfInvoice
        ) {
          unProcessedOverdues.push({
            ...overdue,
            reason:
              'Missing Date of Oldest Invoice.',
          });
          continue;
        }
        if (
          !overdue.overdueType
        ) {
          unProcessedOverdues.push({
            ...overdue,
            reason:
              'Missing Overdue Type.',
          });
          continue;
        }
        if (
          !overdue.insurerId
        ) {
          unProcessedOverdues.push({
            ...overdue,
            reason:
              'Missing Insurer Name.',
          });
          continue;
        }
        if (
          !overdue.outstandingAmount
        ) {
          unProcessedOverdues.push({
            ...overdue,
            reason:
              'Total Outstanding Amount should not be zero.',
          });
          continue;
        }
        overdues.push(overdue);
      }
    }
    return {
      isImportCompleted: true,
      overdues,
      unProcessedOverdues,
    };
  } catch (e) {
    Logger.log.error('Error occurred in add limit list data', e);
  }
};

const processAndValidateOverdues = async (importId) => {
  try {
    const importOverdueDump = await ImportOverdueDump.findOne({
      _id: importId,
    });
    if (!importOverdueDump) {
      return Promise.reject({ message: 'No Import dump found.' });
    }
    if (importOverdueDump.currentStepIndex !== 'GENERATED') {
      return Promise.reject({ message: 'Invalid step index found' });
    }
    const client = await Client.findOne({
      _id: importOverdueDump.clientId,
      isDeleted: false,
    });
    const overdues = [];
    const unProcessedOverdues = [];
    overdueLoop: for (
      let i = 0;
      i < importOverdueDump.overdues.length;
      i++
    ) {
      importOverdueDump.overdues[i].overdueAction = 'UNCHANGED'
      const acnValue = importOverdueDump.overdues[i].acn;
      const entityName = importOverdueDump.overdues[i].entityName;
      let debtor1;
      let debtor2;
      let debtor;
      const insurer = await Insurer.findOne({
        name: importOverdueDump.overdues[i].insurerId,
      });
      if(!insurer) {
        unProcessedOverdues.push({
          ...importOverdueDump.overdues[i],
          reason: `Insurer not found`,
        });
        continue;
      }
      importOverdueDump.overdues[i].insurerId = insurer._id;
      if(entityName) {
        debtor2 = await Debtor.findOne({ entityName: entityName });
        debtor = debtor2;
        if (debtor2?._id) importOverdueDump.overdues[i].debtorId = debtor._id;
      }
      if (acnValue) {
        debtor1 = await Debtor.findOne({ acn: acnValue });
        debtor = debtor1;
        if (debtor1?._id) importOverdueDump.overdues[i].debtorId = debtor._id;
      }
      if(debtor1._id && debtor2._id && debtor1._id.toString !== debtor2._id.toString) {
        unProcessedOverdues.push({
          ...importOverdueDump.overdues[i],
          reason: `ACN and Entity Name is mismatched`,
        });
        continue;
      }
      if (debtor) {
        const overdue = await Overdue.findOne({
          debtorId: debtor._id,
          clientId: client._id,
          status: {
            $nin: [
              'DECLINED',
              'CANCELLED',
              'WITHDRAWN',
              'SURRENDERED',
              'DRAFT',
              'APPROVED',
            ],
          },
        }).lean();
        if (overdue) {
          unProcessedOverdues.push({
            ...importOverdueDump.overdues[i],
            reason: `Overdue already exists for the Client: ${
              client.name
            } & Debtor: ${
              importOverdueDump.overdues[i].debtorCode ||
              importOverdueDump.overdues[i].abn ||
              importOverdueDump.overdues[i].acn
            }`,
          });
          continue;
        }
        overdues.push({
          ...importOverdueDump.overdues[i],
          debtorExists: true,
        });
      } 
      else {
        // if (
        //   importOverdueDump.overdues[i].address.countryCode !== 'AUS' &&
        //   importOverdueDump.overdues[i].address.countryCode !== 'NZL'
        // ) {
        unProcessedOverdues.push({
          ...importOverdueDump.overdues[i],
          reason:`Debtor which matches ACN and Entity Name not found`,
          debtorExists: false,
        });
      }
    }
    return {
      overdues,
      unProcessedOverdues,
    };
  } catch (e) {
    Logger.log.error('Error occurred in add limit list data', e);
  }
};

const updateList = async ({
  importOverdueDump: importOverdueDump,
  isForRisk = false,
  clientId,
  userId,
  userName = null,
  userType,
}) => {
  const unProcessedOverdues = [];
  try {
    const promises = [];
    const newOverdues = [];
    const overdueIds = [];
    let update = {};
    for (let i = 0; i < importOverdueDump.overdues.length; i++) {
      if (
        (isForRisk &&
          (!importOverdueDump.clientId ||
            !mongoose.Types.ObjectId.isValid(importOverdueDump.clientId))) ||
        ((!importOverdueDump.overdues[i].debtorId ||
          !mongoose.Types.ObjectId.isValid(importOverdueDump.overdues[i].debtorId)) &&
          !importOverdueDump.overdues[i].acn) ||
        !importOverdueDump.month ||
        !importOverdueDump.year ||
        !importOverdueDump.overdues[i].dateOfInvoice ||
        !importOverdueDump.overdues[i].overdueType ||
        !importOverdueDump.overdues[i].insurerId ||
        !importOverdueDump.overdues[i].hasOwnProperty('outstandingAmount') ||
        importOverdueDump.overdues[i].outstandingAmount <= 0
      ) {
        unProcessedOverdues.push({
          ...importOverdueDump.overdues[i],
          reason: 'Required fields are missing.',
        });
        continue;
      }
      update = {};
      update.clientId = isForRisk ? importOverdueDump.clientId : clientId;
      update.debtorId = importOverdueDump.overdues[i].debtorId
        ? importOverdueDump.overdues[i].debtorId
        : undefined;
      update.acn = importOverdueDump.overdues[i].acn
        ? importOverdueDump.overdues[i].acn
        : undefined;
      if (importOverdueDump.overdues[i].dateOfInvoice) {
        update.dateOfInvoice = importOverdueDump.overdues[i].dateOfInvoice;
      }
      if (importOverdueDump.overdues[i].overdueType) {
        update.overdueType = importOverdueDump.overdues[i].overdueType;
      }
      if (importOverdueDump.overdues[i].insurerId) {
        update.insurerId = importOverdueDump.overdues[i].insurerId;
      }
      if (importOverdueDump.month) {
        update.month = importOverdueDump.month.toString().padStart(2, '0');
      }
      if (importOverdueDump.year) {
        update.year = importOverdueDump.year.toString();
      }
      if (importOverdueDump.overdues[i].currentAmount) {
        update.currentAmount = importOverdueDump.overdues[i].currentAmount;
      }
      if (importOverdueDump.overdues[i].thirtyDaysAmount) {
        update.thirtyDaysAmount = importOverdueDump.overdues[i].thirtyDaysAmount;
      }
      if (importOverdueDump.overdues[i].sixtyDaysAmount) {
        update.sixtyDaysAmount = importOverdueDump.overdues[i].sixtyDaysAmount;
      }
      if (importOverdueDump.overdues[i].ninetyDaysAmount) {
        update.ninetyDaysAmount = importOverdueDump.overdues[i].ninetyDaysAmount;
      }
      if (importOverdueDump.overdues[i].ninetyPlusDaysAmount) {
        update.ninetyPlusDaysAmount = importOverdueDump.overdues[i].ninetyPlusDaysAmount;
      }
      if (importOverdueDump.overdues[i].outstandingAmount) {
        update.outstandingAmount = importOverdueDump.overdues[i].outstandingAmount;
      }
      if (importOverdueDump.overdues[i].clientComment) {
        update.clientComment = importOverdueDump.overdues[i].clientComment;
      }
      if (importOverdueDump.overdues[i].analystComment) {
        update.analystComment = importOverdueDump.overdues[i].analystComment;
      }
      update.overdueAction = importOverdueDump.overdues[i].overdueAction
        ? importOverdueDump.overdues[i].overdueAction
        : 'UNCHANGED';
      update.status = importOverdueDump.overdues[i].status
        ? importOverdueDump.overdues[i].status
        : 'SUBMITTED';
      if (!importOverdueDump.overdues[i]._id) {
        const overdue = await Overdue.findOne({
          clientId: update.clientId,
          debtorId: update.debtorId,
          month: update.month,
          year: update.year,
        }).lean();
        if (overdue) {
          unProcessedOverdues.push({
            ...importOverdueDump.overdues[i],
            reason: 'Overdue already exists, please create with another debtor',
          });
          continue;
        }
        update.createdByType = userType;
        update.createdById = userId;
        newOverdues.push(await Overdue.create(update));
      } else {
        const overdue = await Overdue.findOne({
          clientId: update.clientId,
          debtorId: update.debtorId,
          month: update.month,
          year: update.year,
        }).lean();
        if (overdue && overdue._id.toString() !== importOverdueDump.overdues[i]._id) {
          unProcessedOverdues.push({
            ...importOverdueDump.overdues[i],
            reason: 'Overdue already exists, please create with another debtor',
          });
          continue;
        }
        // if (!overdue) {
        //   update.createdByType = userType;
        //   update.createdById = userId;
        //   newOverdues.push(Overdue.create(update));
        // } else {
        promises.push(
          Overdue.updateOne({ _id: importOverdueDump.overdues[i]._id }, update, {
            upsert: true,
          }),
        );
        overdueIds.push({
          id: importOverdueDump.overdues[i]._id,
          action: 'edit',
          overdueAction: importOverdueDump.overdues[i].overdueAction,
        });
        // }
      }
    }

    if (newOverdues.length !== 0) {
      const response = await Promise.all(newOverdues);
      response.map((i) =>
        overdueIds.push({
          id: i._id,
          action: 'add',
          overdueAction: i.overdueAction,
        }),
      );
    }
    const response = await Promise.all(promises);
    addNotifications({
      overdueIds,
      userId: userId,
      type: userType,
      userName,
      sendNotifications: userType === 'client-user',
    });
    console.log("response: ", response)
    return {response: response, unProcessedOverdues: unProcessedOverdues};
  } catch (e) {
    Logger.log.error('Error occurred in update list');
    Logger.log.error(e.message || e);
  }
};

const addNotifications = async ({
  userId,
  overdueIds,
  type,
  userName,
  sendNotifications,
}) => {
  try {
    for (let i = 0; i < overdueIds.length; i++) {
      const overdue = await Overdue.findOne({
        _id: overdueIds[i].id,
      })
        .populate({
          path: 'clientId debtorId',
          select: 'name entityName riskAnalystId',
        })
        .lean();
      if (overdue) {
        const description =
          overdueIds[i].action === 'add'
            ? overdueIds[i]?.overdueAction === 'MARK_AS_PAID'
              ? `A new overdue of ${overdue?.clientId?.name} and ${
                  overdue?.debtorId?.entityName || overdue?.acn
                } is marked as paid by ${
                  type === 'user' ? userName : overdue?.clientId?.name
                }`
              : `A new overdue of ${overdue?.clientId?.name} and ${
                  overdue?.debtorId?.entityName || overdue?.acn
                } is generated by ${
                  type === 'user' ? userName : overdue?.clientId?.name
                }`
            : overdueIds[i]?.overdueAction === 'MARK_AS_PAID'
            ? `An overdue of ${overdue?.clientId?.name} and ${
                overdue?.debtorId?.entityName || overdue?.acn
              } is marked as paid by ${
                type === 'user' ? userName : overdue?.clientId?.name
              }`
            : `An overdue of ${overdue?.clientId?.name} and ${
                overdue?.debtorId?.entityName || overdue?.acn
              } is updated by ${
                type === 'user' ? userName : overdue?.clientId?.name
              }`;
        addAuditLog({
          entityType: 'overdue',
          entityRefId: overdue._id,
          actionType: overdueIds[i].action,
          userType: type,
          userRefId: userId,
          logDescription: description,
        });
        if (sendNotifications) {
          const notification = await addNotification({
            userId:
              type === 'user'
                ? overdue?.clientId?._id
                : overdue?.clientId?.riskAnalystId,
            userType: type === 'user' ? 'client-user' : 'user',
            description: description,
            entityId: overdue._id,
            entityType: 'overdue',
          });
          if (notification) {
            sendNotification({
              notificationObj: {
                type: 'OVERDUE',
                data: notification,
              },
              type: notification.userType,
              userId: notification.userId,
            });
          }
        }
      }
    }
  } catch (e) {
    Logger.log.error('Error occurred in add notification');
    Logger.log.error(e);
  }
};

// // readExcelFile();
module.exports = {
  readExcelFile,
  processAndValidateOverdues,
  updateList,
};
