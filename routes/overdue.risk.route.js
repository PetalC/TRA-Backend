/*
 * Module Imports
 * */
const moment = require('moment')
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Debtor = mongoose.model('debtor');
const Insurer = mongoose.model('insurer');
const Overdue = mongoose.model('overdue');
const Client = mongoose.model('client');
const User = mongoose.model('user');
const ClientUser = mongoose.model('client-user');
const UploadedOverdueCsv = mongoose.model('uploaded-overdue-csv');
const fs = require('fs');
const multer = require('multer');
const csv = require('fast-csv');
/*
 * Local Imports
 * */
const Logger = require('./../services/logger');
const {
  getDrawerDetails,
  getLastOverdueList,
  getOverdueList,
  getMonthString,
  formatString,
  updateList,
  downloadOverdueList,
  addOverdue,
} = require('./../helper/overdue.helper');
const { insurerList } = require('./../helper/task.helper');
const { getClientList } = require('./../helper/client.helper');
const { getCurrentDebtorList } = require('./../helper/debtor.helper');
const { generateExcel } = require('../helper/excel.helper');
const { addNotification } = require('../helper/notification.helper');
const { sendNotification } = require('../helper/socket.helper');
const {
  addUploadedOverdueCsv,
} = require('./../helper/uploaded-overdue-csv.helper');

const upload = multer({ dest: 'upload/overdue-csv' });
/**
 * Get Entity List
 */
router.get('/entity-list', async function (req, res) {
  try {
    let hasFullAccess = true;
    if (req.accessTypes && req.accessTypes.indexOf('full-access') === -1) {
      hasFullAccess = false;
    }
    const clients = await getClientList({
      hasFullAccess,
      userId: req.user._id,
      page: req.query.page,
      limit: req.query.limit,
    });
    const response = await getCurrentDebtorList({
      userId: req.user._id,
      hasFullAccess,
      isForRisk: true,
      limit: req.query.limit,
      page: req.query.page,
      showCompleteList: false,
      isForOverdue: true,
    });
    const insurer = await insurerList();
    const overdueTypes = [
      { _id: 'PAID', name: 'Paid' },
      { _id: 'INSOLVENCY', name: 'Insolvency' },
      { _id: 'REPAYMENT_PLAN', name: 'Repayment Plan' },
      { _id: 'RETURNED_CHEQUE', name: 'Returned Cheque' },
      { _id: 'RETENTION', name: 'Retention' },
      { _id: 'PAYMENT_EXPECTED', name: 'Payment expected' },
      { _id: 'DISPUTE', name: 'Dispute' },
      { _id: 'LEGAL/COLLECTIONS', name: 'Legal/Collections' },
    ];
    res.status(200).send({
      status: 'SUCCESS',
      data: {
        clientId: clients,
        debtorId: response,
        overdueType: overdueTypes,
        insurerId: insurer,
      },
    });
  } catch (e) {
    Logger.log.error(
      'Error occurred in get overdue drop-down list',
      e.message || e,
    );
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

/**
 * Get Month & Year Overdue
 */
router.get('/list', async function (req, res) {
  if (
    !req.query.month ||
    !req.query.year ||
    !req.query.clientId ||
    !mongoose.Types.ObjectId.isValid(req.query.clientId)
  ) {
    return res.status(400).send({
      status: 'ERROR',
      messageCode: 'REQUIRE_FIELD_MISSING',
      message: 'Require fields are missing.',
    });
  }
  try {
    // let month = new Date(req.query.date).getMonth() + 1;
    // let year = new Date(req.query.date).getFullYear();
    const query = {
      month: req.query.month.toString().padStart(2, '0'),
      year: req.query.year.toString(),
      clientId: req.query.clientId,
    };
    const overdue = await Overdue.find(query)
      .populate({
        path: 'debtorId insurerId',
        select: '_id entityName name',
      })
      .select({ isDeleted: 0, createdAt: 0, updatedAt: 0, __v: 0 })
      .lean();
    let client = await Client.findById(req.query.clientId)
      .select('_id name')
      .lean();
    client = client && client.name ? client.name : '';
    if (overdue && overdue.length !== 0) {
      let isNilOverdue = false;
      for (let i = 0; i < overdue.length; i++) {
        if (overdue[i].nilOverdue) {
          isNilOverdue = true;
          break;
        } else {
          overdue[i].isExistingData = true;
          if (overdue[i].overdueAction !== 'MARK_AS_PAID') {
            delete overdue[i].overdueAction;
          }
          if (overdue[i].debtorId && overdue[i].debtorId.entityName) {
            overdue[i].debtorId = {
              label: overdue[i].debtorId.entityName,
              value: overdue[i].debtorId._id,
            };
          }
          if (overdue[i].insurerId && overdue[i].insurerId.name) {
            overdue[i].insurerId = {
              label: overdue[i].insurerId.name,
              value: overdue[i].insurerId._id,
            };
          }
          overdue[i].overdueType = {
            value: overdue[i].overdueType,
            label: formatString(overdue[i].overdueType),
          };
          overdue[i].status = {
            value: overdue[i].status,
            label: formatString(overdue[i].status),
          };
          overdue[i].index =
            req.query.clientId +
            (overdue[i]?.debtorId?._id ? overdue[i].debtorId._id : '') +
            (overdue[i]?.acn ? overdue[i].acn : '') +
            i;
        }
      }
      return res.status(200).send({
        status: 'SUCCESS',
        data: { docs: isNilOverdue ? [] : overdue, client, isNilOverdue },
      });
    } else {
      // query.overdueAction = { $ne: 'MARK_AS_PAID' };
      let { overdue, lastMonth, lastYear } = await getLastOverdueList({
        query,
        date: new Date(query?.year, query?.month, 1, 0, 0, 0),
      });
      const response = {
        docs: overdue,
        client,
        isNilOverdue: false,
      };
      if (overdue && overdue.length !== 0) {
        const docs = [];
        /*overdue.forEach((i) => {
          i.isExistingData = true;
          i.month = req.query.month;
          i.year = req.query.year;
          if (i.debtorId && i.debtorId.entityName) {
            i.debtorId = {
              label: i.debtorId.entityName,
              value: i.debtorId._id,
            };
          }
          if (i.insurerId && i.insurerId.name) {
            i.insurerId = {
              label: i.insurerId.name,
              value: i.insurerId._id,
            };
          }
          i.overdueType = {
            value: i.overdueType,
            label: formatString(i.overdueType),
          };
          i.status = {
            value: 'SUBMITTED',
            label: 'Submitted',
          };
        });*/
        for (let i = 0; i < overdue.length; i++) {
          if (overdue[i].nilOverdue) {
            response.isNilOverdue = true;
            break;
          } else {
            if (overdue[i].overdueAction !== 'MARK_AS_PAID') {
              overdue[i].isExistingData = true;
              overdue[i].month = req.query.month;
              overdue[i].year = req.query.year;
              if (overdue[i].debtorId && overdue[i].debtorId.entityName) {
                overdue[i].debtorId = {
                  label: overdue[i].debtorId.entityName,
                  value: overdue[i].debtorId._id,
                };
              }
              if (overdue[i].insurerId && overdue[i].insurerId.name) {
                overdue[i].insurerId = {
                  label: overdue[i].insurerId.name,
                  value: overdue[i].insurerId._id,
                };
              }
              overdue[i].overdueType = {
                value: overdue[i].overdueType,
                label: formatString(overdue[i].overdueType),
              };
              overdue[i].status = {
                value: 'SUBMITTED',
                label: 'Submitted',
              };
              delete overdue[i]._id;
              delete overdue[i].overdueAction;
              overdue[i].index =
                req.query.clientId +
                (overdue[i]?.debtorId?._id ? overdue[i].debtorId._id : '') +
                (overdue[i]?.acn ? overdue[i].acn : '') +
                i;
              docs.push(overdue[i]);
            }
          }
        }
        if (response.isNilOverdue) {
          response.docs = [];
          response.previousEntries = getMonthString(lastMonth) + ' ' + lastYear;
        } else {
          response.docs = docs;
          if (docs.length !== 0) {
            response.previousEntries =
              getMonthString(lastMonth) + ' ' + lastYear;
          }
        }
      }
      return res.status(200).send({
        status: 'SUCCESS',
        data: response,
      });
    }
  } catch (e) {
    Logger.log.error('Error occurred in get selected month and year list', e);
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

/**
 * Overdue drawer details
 */
router.get('/details/:overdueId', async function (req, res) {
  if (
    !req.params.overdueId ||
    !mongoose.Types.ObjectId.isValid(req.params.overdueId)
  ) {
    return res.status(400).send({
      status: 'ERROR',
      messageCode: 'REQUIRE_FIELD_MISSING',
      message: 'Require fields are missing.',
    });
  }
  try {
    const overdue = await getDrawerDetails({
      overdueId: req.params.overdueId,
      isForRisk: true,
    });
    return res.status(200).send({
      status: 'SUCCESS',
      data: { response: overdue, header: 'Overdue Details' },
    });
  } catch (e) {
    Logger.log.error('Error occurred in get drawer details', e.message || e);
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

/**
 * Get overdue list
 */
router.get('/', async function (req, res) {
  try {
    let hasFullAccess = true;
    if (req.accessTypes && req.accessTypes.indexOf('full-access') === -1) {
      hasFullAccess = false;
    }
    const { overdueList, headers, total } = await getOverdueList({
      requestedQuery: req.query,
      hasFullAccess: hasFullAccess,
      isForRisk: true,
      userId: req.user._id,
    });
    res.status(200).send({
      status: 'SUCCESS',
      data: {
        docs: overdueList[0].paginatedResult,
        headers,
        total,
        page: parseInt(req.query.page),
        limit: parseInt(req.query.limit),
        pages: Math.ceil(total / parseInt(req.query.limit)),
        sortOption: parseInt(req.query.sortOption)
      },
    });
  } catch (e) {
    Logger.log.error('Error occurred in get overdue list ', e.message || e);
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

/**
 * Download overdue list
 */
router.get('/download', async function (req, res) {
  if (!req.query.startDate && !req.query.endDate) {
    return res.status(400).send({
      status: 'ERROR',
      messageCode: 'REQUIRE_FIELD_MISSING',
      message: 'Require field is missing.',
    });
  }
  try {
    const {
      overdueList,
      headers,
      filters,
      clients,
    } = await downloadOverdueList({
      requestedQuery: req.query,
    });
    const finalArray = [];
    const clientNames = [];
    let data;
    if (overdueList.length !== 0) {
      overdueList.forEach((i) => {
        data = {};
        data['clientName'] = i['clientName'];
        clientNames.push(i['clientName']);
        data = Object.assign(
          data,
          ...i.records.map((object) => ({
            [object.month + '-' + object.year]: object.count,
          })),
        );
        headers.map((key) => {
          if (!data[key.name]) {
            data[key.name] = '-';
          }
        });
        finalArray.push(data);
      });
    }

    clients.forEach((client) => {
      if (!clientNames.includes(client.name)) {
        data = {};
        data['clientName'] = client['name'];
        headers.map((key) => {
          data[key.name] = '-';
        });
        finalArray.push(data);
      }
    });
    headers.unshift({
      name: 'clientName',
      label: 'Client Name',
      type: 'string',
    });
    const excelData = await generateExcel({
      data: finalArray,
      reportFor: 'Overdue Report',
      headers,
      filter: filters,
      title: 'Report for',
    });
    const fileName = 'overdue-report-' + new Date().getTime() + '.xlsx';
    res.header(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename=' + fileName);
    res.status(200).send(excelData);
  } catch (e) {
    Logger.log.error('Error occurred in download overdue list', e.message || e);
    res.status(e.messageCode === 'DOWNLOAD_LIMIT_EXCEED' ? 400 : 500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

/**
 * Get Specific Entity Overdue List
 */
router.get('/:entityId', async function (req, res) {
  if (
    !req.params.entityId ||
    !mongoose.Types.ObjectId.isValid(req.params.entityId) ||
    !req.query.entityType
  ) {
    return res.status(400).send({
      status: 'ERROR',
      messageCode: 'REQUIRE_FIELD_MISSING',
      message: 'Require fields are missing.',
    });
  }
  try {
    const { overdueList, headers, total } = await getOverdueList({
      requestedQuery: req.query,
      isForRisk: true,
      userId: req.user._id,
      entityId: req.params.entityId,
      isForSubmodule: true,
    });
    res.status(200).send({
      status: 'SUCCESS',
      data: {
        docs: overdueList[0].paginatedResult,
        headers,
        total,
        page: parseInt(req.query.page),
        limit: parseInt(req.query.limit),
        pages: Math.ceil(total / parseInt(req.query.limit)),
      },
    });
  } catch (e) {
    Logger.log.error(
      'Error occurred while get specific overdue detail',
      e.message || e,
    );
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

/*/!**
 * Add overdue
 *!/
router.post('/', async function (req, res) {
  if (
    !req.body.clientId ||
    !mongoose.Types.ObjectId.isValid(req.body.clientId) ||
    !req.body.debtorId ||
    !mongoose.Types.ObjectId.isValid(req.body.debtorId) ||
    !req.body.acn ||
    !req.body.dateOfInvoice ||
    !req.body.overdueType ||
    !req.body.insurerId ||
    !req.body.month ||
    !req.body.year ||
    !req.body.hasOwnProperty('currentAmount') ||
    !req.body.hasOwnProperty('thirtyDaysAmount') ||
    !req.body.hasOwnProperty('sixtyDaysAmount') ||
    !req.body.hasOwnProperty('ninetyDaysAmount') ||
    !req.body.hasOwnProperty('ninetyPlusDaysAmount') ||
    !req.body.hasOwnProperty('outstandingAmount')
  ) {
    return res.status(400).send({
      status: 'ERROR',
      messageCode: 'REQUIRE_FIELD_MISSING',
      message: 'Require fields are missing.',
    });
  }
  try {
    const overdueDetail = await Overdue.findOne({
      clientId: req.body.clientId,
      debtorId: req.body.debtorId,
      month: req.body.month.toString().padStart(2, '0'),
      year: req.body.year.toString(),
    }).lean();
    if (overdueDetail) {
      return res.status(400).send({
        status: 'ERROR',
        messageCode: 'OVERDUE_ALREADY_EXISTS',
        message: 'Overdue already exists, please create with another debtor',
      });
    }
    let overdue = {
      clientId: req.body.clientId,
      debtorId: req.body.debtorId,
      acn: req.body.acn,
      dateOfInvoice: req.body.dateOfInvoice,
      overdueType: req.body.overdueType,
      insurerId: req.body.insurerId,
      month: req.body.month.toString().padStart(2, '0'),
      year: req.body.year,
      currentAmount: req.body.currentAmount,
      thirtyDaysAmount: req.body.thirtyDaysAmount,
      sixtyDaysAmount: req.body.sixtyDaysAmount,
      ninetyDaysAmount: req.body.ninetyDaysAmount,
      ninetyPlusDaysAmount: req.body.ninetyPlusDaysAmount,
      outstandingAmount: req.body.outstandingAmount,
      clientComment: req.body.clientComment,
      analystComment: req.body.analystComment,
      status: 'SUBMITTED',
    };
    const overdueData = await Overdue.create(overdue);
    overdue = await Overdue.findOne({ _id: overdueData._id })
      .populate({
        path: 'debtorId',
        select: '_id entityName',
      })
      .select(
        '_id debtorId overdueType overdueAction status month year outstandingAmount',
      )
      .lean();
    if (overdue) {
      overdue.isExistingData = true;
      if (overdue.debtorId && overdue.debtorId.entityName) {
        overdue.debtorId = overdue.debtorId.entityName;
      }
      overdue.overdueType = formatString(overdue.overdueType);
      overdue.status = formatString(overdue.status);
    }
    res.status(200).send({
      status: 'SUCCESS',
      message: 'Overdue added successfully',
      data: overdue,
    });
  } catch (e) {
    Logger.log.error('Error occurred in add overdue', e.message || e);
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});*/

/**
 * Save overdue list
 */
router.put('/list', async function (req, res) {
  if (
    !req.body.hasOwnProperty('nilOverdue') ||
    !req.body.hasOwnProperty('oldNilOverdue')
  ) {
    return res.status(400).send({
      status: 'ERROR',
      messageCode: 'REQUIRE_FIELD_MISSING',
      message: 'Require fields are missing.',
    });
  }
  try {
    if (req.body.nilOverdue !== req.body.oldNilOverdue) {
      await Overdue.deleteMany({
        clientId: req.body.clientId,
        month: req.body.month,
        year: req.body.year,
      });
    }
    if (!req.body.nilOverdue) {
      if (!req.body.list || req.body.list.length === 0) {
        return res.status(400).send({
          status: 'ERROR',
          messageCode: 'REQUIRE_FIELD_MISSING',
          message: 'Require fields are missing.',
        });
      }
      const overdueArr = req.body.list.map((i) => {
        return (
          i.clientId +
          (i.debtorId ? i.debtorId : i.acn) +
          i.month.toString().padStart(2, '0') +
          i.year
        );
      });
      let isDuplicate = overdueArr.some((element, index) => {
        return overdueArr.indexOf(element) !== index;
      });
      if (isDuplicate) {
        return res.status(400).send({
          status: 'ERROR',
          messageCode: 'INVALID_DATA',
          message: 'Overdue list is invalid',
        });
      }
      const response = await updateList({
        isForRisk: true,
        requestBody: req.body,
        userId: req.user._id,
        userName: req.user.name,
        userType: 'user',
      });
      if (response && response.status && response.status === 'ERROR') {
        return res.status(400).send(response);
      }
    } else {
      if (
        req.body.list.length !== 0 ||
        !req.body.month ||
        !req.body.year ||
        !req.body.clientId
      ) {
        return res.status(400).send({
          status: 'ERROR',
          messageCode: 'REQUIRE_FIELD_MISSING',
          message: 'Require fields are missing.',
        });
      }

      //TODO send notifications
      await Overdue.updateOne(
        {
          clientId: req.body.clientId,
          month: req.body.month,
          year: req.body.year,
        },
        {
          clientId: req.body.clientId,
          month: req.body.month,
          year: req.body.year,
          nilOverdue: req.body.nilOverdue,
          list: [],
          status: 'REPORTED_TO_INSURER',
          createdById: req.user._id,
          createdByType: 'user',
        },
        {
          upsert: true,
          setDefaultsOnInsert: true,
        },
      );
    }
    res.status(200).send({
      status: 'SUCCESS',
      message: 'Overdue list updated successfully',
    });
  } catch (e) {
    Logger.log.error('Error occurred in save overdue list', e.message || e);
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

/**
 * Update overdue status
 */
router.put('/status/:overdueId', async function (req, res) {
  if (
    !req.params.overdueId ||
    !mongoose.Types.ObjectId.isValid(req.params.overdueId) ||
    !req.body.status
  ) {
    return res.status(400).send({
      status: 'ERROR',
      messageCode: 'REQUIRE_FIELD_MISSING',
      message: 'Require fields are missing.',
    });
  }
  try {
    const query = {
      _id: req.params.overdueId,
    };
    if (req.body.status === 'PENDING') {
      query.status = 'SUBMITTED';
    }
    await Overdue.updateOne(query, { status: req.body.status });
    const overdue = await Overdue.findOne({ _id: req.params.overdueId })
      .populate({
        path: 'debtorId',
        select: '_id entityName',
      })
      .select(
        '_id debtorId overdueType overdueAction status month year outstandingAmount',
      )
      .lean();
    if (overdue) {
      overdue.isExistingData = true;
      if (overdue.debtorId && overdue.debtorId.entityName) {
        overdue.debtorId = overdue.debtorId.entityName;
      }
      overdue.overdueType = formatString(overdue.overdueType);
      overdue.status = formatString(overdue.status);
    }
    res.status(200).send({
      status: 'SUCCESS',
      message: 'Overdue status updated successfully',
      data: overdue,
    });
  } catch (e) {
    Logger.log.error('Error occurred in update status', e.message || e);
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

/*
/!**
 * Update overdue
 *!/
router.put('/:overdueId', async function (req, res) {
  if (
    !req.params.overdueId ||
    !mongoose.Types.ObjectId.isValid(req.params.overdueId) ||
    !req.body.clientId ||
    !mongoose.Types.ObjectId.isValid(req.body.clientId)
  ) {
    return res.status(400).send({
      status: 'ERROR',
      messageCode: 'REQUIRE_FIELD_MISSING',
      message: 'Require fields are missing.',
    });
  }
  try {
    if (req.body.debtorId || req.body.month || req.body.year) {
      const query = {
        clientId: req.body.clientId,
      };
      if (req.body.debtorId) {
        query.debtorId = req.body.debtorId;
      }
      if (req.body.month && req.body.year) {
        query.month = req.body.month.toString().padStart(2, '0');
        query.year = req.body.year.toString();
      }
      const overdueDetail = await Overdue.findOne(query).lean();
      if (
        overdueDetail &&
        overdueDetail._id.toString() !== req.params.overdueId.toString()
      ) {
        return res.status(400).send({
          status: 'ERROR',
          messageCode: 'OVERDUE_ALREADY_EXISTS',
          message: 'Overdue already exists, please create with another debtor',
        });
      }
    }
    const update = {};
    if (req.body.debtorId) update.debtorId = req.body.debtorId;
    if (req.body.acn) update.acn = req.body.acn;
    if (req.body.dateOfInvoice) update.dateOfInvoice = req.body.dateOfInvoice;
    if (req.body.overdueType) update.overdueType = req.body.overdueType;
    if (req.body.insurerId) update.insurerId = req.body.insurerId;
    if (req.body.month)
      update.month = req.body.month.toString().padStart(2, '0');
    if (req.body.currentAmount) update.currentAmount = req.body.currentAmount;
    if (req.body.thirtyDaysAmount)
      update.thirtyDaysAmount = req.body.thirtyDaysAmount;
    if (req.body.sixtyDaysAmount)
      update.sixtyDaysAmount = req.body.sixtyDaysAmount;
    if (req.body.ninetyDaysAmount)
      update.ninetyDaysAmount = req.body.ninetyDaysAmount;
    if (req.body.ninetyPlusDaysAmount)
      update.ninetyPlusDaysAmount = req.body.ninetyPlusDaysAmount;
    if (req.body.outstandingAmount)
      update.outstandingAmount = req.body.outstandingAmount;
    if (req.body.clientComment) update.clientComment = req.body.clientComment;
    if (req.body.analystComment)
      update.analystComment = req.body.analystComment;
    await Overdue.updateOne({ _id: req.params.overdueId }, update);
    const overdue = await Overdue.findOne({ _id: req.params.overdueId })
      .populate({
        path: 'debtorId',
        select: '_id entityName',
      })
      .select(
        '_id debtorId overdueType overdueAction status month year outstandingAmount',
      )
      .lean();
    if (overdue) {
      overdue.isExistingData = true;
      if (overdue.debtorId && overdue.debtorId.entityName) {
        overdue.debtorId = overdue.debtorId.entityName;
      }
      overdue.overdueType = formatString(overdue.overdueType);
      overdue.status = formatString(overdue.status);
    }
    res.status(200).send({
      status: 'SUCCESS',
      message: 'Overdue status updated successfully',
      data: overdue,
    });
  } catch (e) {
    Logger.log.error('Error occurred in update overdue', e.message || e);
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});
*/

/**
 * Bulk Upload Overdues
 */
router.post('/upload-csv', upload.single('overdue-csv'), async (req, res) => {
  try {
    const user = await User.findOne(req.user._id).lean();

    // parse overdue csv file and add overdues to the correct client
    const overdues = [];
    const createdOverdues = [];

    Logger.log.info('Uploaded File path: ', req.file.path);

    csv
      .parseFile(req.file.path)
      .on('data', function (row) {
        overdues.push(row);
      })
      .on('end', async function () {
        // remove the header
        overdues.shift();

        // add new uploaded overdue csv
        const newUploadedOverdueCsv = await addUploadedOverdueCsv({
          submittedById: user._id,
          submittedByType: 'user',
        });

        for (const overdue of overdues) {
          const clientId = req.body?.id ?? null;
          let insurerId =
            (await Insurer.findOne({ name:overdue[4] }).lean())?._id ??
            null;
          const debtorId =
            (await Debtor.findOne({ entityName: overdue[1] }).lean())?._id ??
            null;
          const acn = overdue[0];
          const dateOfInvoice = new Date(overdue[2]);
          const overdueType = overdue[3].toUpperCase();
          const month = ('0' + (dateOfInvoice.getMonth() + 1)).slice(-2);
          const year = dateOfInvoice.getFullYear();
          const clientComment = overdue[11] ?? '';
          const analystComment = '';
          const currentAmount = parseFloat(overdue[5].replace(/[^0-9.]/g, ''));
          const thirtyDaysAmount = parseFloat(overdue[6].replace(/[^0-9.]/g, ''));
          const sixtyDaysAmount = parseFloat(overdue[7].replace(/[^0-9.]/g, ''));
          const ninetyDaysAmount = parseFloat(overdue[8].replace(/[^0-9.]/g, ''));
          const ninetyPlusDaysAmount = parseFloat(
            overdue[9].replace(/[^0-9.]/g, '')
          );
          const outstandingAmount = parseFloat(
            overdue[10].replace(/[^0-9.]/g, '')
          );
          const createdByType = 'user';
          const createdById = user._id;

          const newOverdue = await addOverdue({
            clientId,
            debtorId,
            acn,
            dateOfInvoice,
            overdueType,
            insurerId,
            month,
            year,
            clientComment,
            analystComment,
            currentAmount,
            thirtyDaysAmount,
            sixtyDaysAmount,
            ninetyDaysAmount,
            ninetyPlusDaysAmount,
            outstandingAmount,
            createdByType,
            createdById,
            isCreatedByBulkUpload: true,
            bulkUploadId: newUploadedOverdueCsv._id,
          });

          createdOverdues.push(newOverdue);
        }

        fs.unlinkSync(req.file.path);

        res.status(200).send({
          status: 'SUCCESS',
          data: {
            overdue: createdOverdues,
          },
        });
      });
  } catch (e) {
    Logger.log.error('Error occurred in bulk upload overdue ', e.message || e);

    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

/**
 * Get uploaded-overdue-csv-list
 */
router.get('/uploaded-csv-list/:clientId', async function (req, res) {
  try {
    if (!req.params.clientId) {
      Logger.log.warn('No clientId passed.');
      return res.status(400).send({
        status: 'ERROR',
        messageCode: 'REQUIRE_FIELD_MISSING',
        message: 'Require fields are missing',
      });
    }

    const client_users = await ClientUser.find({ clientId: req.params.clientId }).lean();
    /*let result=[];
    for (const client_user of client_users) {
      const overdue_csvs = await UploadedOverdueCsv.find({submittedById: client_user._id}).lean();
      overdue_csvs.forEach(csv => {
        csv = {
          ...csv,
          name:client_user.name
        }
        result = [...result, csv];
      });
    };*/
    const query = {
      submittedById: { $in: client_users.map(user => user._id) },
      submittedByType: 'client-user'
    };
    
    const pageSize = parseInt(req.query.limit); // Set the desired page size
    const currentPage = parseInt(req.query.page); // Set the current page number

    const result = await UploadedOverdueCsv.aggregate([
      { $match: query },
      { $sort: { createdAt: -1 } },
      { $skip: (currentPage - 1) * pageSize },
      { $limit: pageSize }
    ]).exec();
    
    let csvResults = [];
    for(const csv of result) {
      const client_user = await ClientUser.findOne({ _id : csv.submittedById })
      let t = {
        ...csv,
        name: client_user.name,
      }
      csvResults = [...csvResults, t];
    }
    
    const total = await UploadedOverdueCsv.countDocuments(query);
    res.status(200).send({ status: 'SUCCESS',       
      data: {
        docs: csvResults,
        total,
        page: parseInt(req.query.page),
        limit: parseInt(req.query.limit),
        pages: Math.ceil(total / parseInt(req.query.limit)),
      }, 
    });
  } catch (e) {
    Logger.log.error('Error occurred in get overduecsv list ', e.message || e);
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

/**
 * Undo uploaded-overdue-csv
 */

router.delete('/undo-uploaded-csv/:csvId', async function (req, res) {
  if (!req.params.csvId) {
    return res.status(400).send({
      status: 'ERROR',
      messageCode: 'REQUIRE_FIELD_MISSING',
      message: 'Require fields are missing',
    });
  }
  try {
    const csv = await UploadedOverdueCsv.findOne({ _id: req.params.csvId });
    if(csv) {
      const client_user = await ClientUser.findOne({ _id: csv.submittedById })
      const notification = await addNotification({
        userId: client_user.clientId,
        userType: 'client-user',
        description: `The Uploaded data uploaded on ${moment(csv.createdAt).format('DD/MM/YYYY')} by ${client_user.name} has been removed. Please review this data before upload again.`,
        entityId: client_user.clientId,
        entityType: 'undo-overdue-csv',
      });
      sendNotification({
        notificationObj: {
          type: 'UNDO_UPLOADED_OVERDUE',
          data: notification,
        },
        type: notification.userType,
        userId: notification.userId,
      });
      await csv.deleteOne();
      await Overdue.deleteMany( { bulkUploadId: req.params.csvId } );
      res.status(200).send({
        status: 'SUCCESS',
        message: 'Import dump deleted successfully.',
      });
    }

  } catch (e) {
    Logger.log.error('Error occurred in delete file module', e.message || e);
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

router.get('/client-id-by-csv-id/:csvId', async function (req, res) {
  try {
    if (!req.params.csvId) {
      Logger.log.warn('No csvId passed.');
      return res.status(400).send({
        status: 'ERROR',
        messageCode: 'REQUIRE_FIELD_MISSING',
        message: 'Require fields are missing',
      });
    }

    const csv = await UploadedOverdueCsv.findOne({ _id:req.params.csvId });
    const client = await ClientUser.findOne({ _id: csv.submittedById });
    res.status(200).send({ status: 'SUCCESS',       
      data: client.clientId, 
    });
  } catch (e) {
    Logger.log.error('Error occurred in get overduecsv list ', e.message || e);
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

router.get('/get-overdue-list-by-id/:csvId', async function (req, res) {
  try {
    if (!req.params.csvId) {
      Logger.log.warn('No csvId passed.');
      return res.status(400).send({
        status: 'ERROR',
        messageCode: 'REQUIRE_FIELD_MISSING',
        message: 'Require fields are missing',
      });
    }

    const overdues = await Overdue.find({ bulkUploadId:req.params.csvId }).lean();
    res.status(200).send({ status: 'SUCCESS',       
      data: overdues, 
    });
  } catch (e) {
    Logger.log.error('Error occurred in get overduecsv list ', e.message || e);
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

router.get('/download/overdue-list', async function (req, res) {
  try {
    if (!req.query?.ids) {
      Logger.log.warn('No ids passed.');
      return res.status(400).send({
        status: 'ERROR',
        messageCode: 'REQUIRE_FIELD_MISSING',
        message: 'Require fields are missing',
      });
    }
    const ids = req.query.ids;
    Overdue.find({ _id: { $in: ids } }).populate('debtorId insurerId').exec((err, records) => {
      // Create a writable stream for the CSV file
      res.setHeader('Content-Type', 'text/csv');
      const fileName = new Date().getTime() + '_overduelist.csv';
      res.setHeader('Content-Disposition', 'attachment; filename=' + fileName);

      const csvStream = csv.format({ headers: true });
      csvStream.pipe(res);

      // Write the data to the CSV stream
      records.forEach((item) => {
        const row = {
          'Debtor ACN *': item.debtorId.acn,
          'Debtor Entity Name *': item.debtorId.entityName,
          'Date of Oldest Invoice *': item.dateOfInvoice,
          'Overdue Type *': item.overdueType,
          'Insurer Name *': item.insurerId.name,
          'Current Oustanding Amount *': '$' + item.currentAmount,
          '30 Days Outstanding Amount *': '$' + item.thirtyDaysAmount,
          '60 Days Outstanding Amount *': '$' + item.sixtyDaysAmount,
          '90 Days Outstanding Amount *': '$' + item.ninetyDaysAmount,
          '90+ Days Outstanding Amount *': '$' + item.ninetyPlusDaysAmount,
          'Total Outstanding Amount': '$' + item.outstandingAmount,
          'Client Comment': item.clientComment
        };
        csvStream.write(row);
      });
      csvStream.end();
    });
  } catch (e) {
    Logger.log.error('Error occurred in downloading overduecsv list ', e.message || e);
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});
/**
 * Export Router
 */
module.exports = router;
