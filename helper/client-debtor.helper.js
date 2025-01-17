/*
 * Module Imports
 * */
const mongoose = require('mongoose');
const ClientDebtor = mongoose.model('client-debtor');
const Client = mongoose.model('client');
const Debtor = mongoose.model('debtor');
const Application = mongoose.model('application');

/*
 * Local Imports
 * */
const Logger = require('./../services/logger');
const { Parser } = require('json2csv');
const { formatString } = require('./overdue.helper');
const { addNotification } = require('./notification.helper');
const { sendNotification } = require('./socket.helper');
const { generateDecisionLetter } = require('./pdf-generator.helper');
const { getRegexForSearch } = require('./audit-log.helper');
const StaticData = require('./../static-files/staticData.json')

const getClientDebtorDetails = async ({ debtor, manageColumns }) => {
  try {
    if (debtor.debtorId && debtor.debtorId.entityType) {
      debtor.debtorId.entityType = debtor.debtorId.entityType
        .replace(/_/g, ' ')
        .replace(/\w\S*/g, function (txt) {
          return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
        });
    }
    let response = [];
    let value = '';
    manageColumns.forEach((i) => {
      const addressFields = [
        'property',
        'unitNumber',
        'streetNumber',
        'streetName',
        'streetType',
        'suburb',
        'state',
        'country',
        'postCode',
      ];
      if (addressFields.includes(i.name)) {
        response.push({
          label: i.label,
          value:
            i.name === 'country'
              ? debtor['debtorId']['address'][i.name]['name']
              : debtor['debtorId']['address'][i.name] || '',
          type: i.type,
        });
      } else {
        value =
          i.name === 'creditLimit' ||
          i.name === 'createdAt' ||
          i.name === 'updatedAt'
            ? debtor[i.name]
            : debtor['debtorId'][i.name];
        if (i.name === 'isActive' || i.name === 'isAutoApproveAllowed') {
          value = value ? 'Yes' : 'No';
        }
        if (value) {
          response.push({
            label: i.label,
            value: value || '-',
            type: i.type,
          });
        }
      }
    });
    return response;
  } catch (e) {
    Logger.log.error(
      'Error occurred in get client-debtor details ',
      e.message || e,
    );
  }
};

const getClientCreditLimit = async ({
  debtorColumn,
  requestedQuery,
  moduleColumn,
  clientId,
  isForRisk = true,
  hasOnlyReadAccessForDebtorModule = false,
  hasOnlyReadAccessForApplicationModule = false,
  isForDownload = false,
}) => {
  try {
    let sendAsHeader = true;
    let sendLimitAsHeader = true;
    if (!isForDownload) {
      debtorColumn.push('isFromOldSystem');
      if (!debtorColumn.includes('limitType')) {
        sendAsHeader = false;
        debtorColumn.push('limitType');
      }
      if (!debtorColumn.includes('creditLimit')) {
        sendLimitAsHeader = false;
        debtorColumn.push('creditLimit');
      }
    } else {
      debtorColumn.push('activeApplicationId');
      debtorColumn.push('address.country');
    }
    const filterArray = [];
    const clientDebtorDetails = [
      'creditLimit',
      'expiryDate',
      'isFromOldSystem',
      'createdAt',
      'updatedAt',
    ];
    const applicationDetails = [
      'limitType',
      'expiryDate',
      'activeApplicationId',
      'approvalOrDecliningDate',
      'approvalType',
    ];
    const queryFilter = {
      // isActive: true,
      clientId: mongoose.Types.ObjectId(clientId),
      status: { $exists: true, $in: ['APPROVED', 'DECLINED'] },
      // creditLimit: { $exists: true, $ne: null },
      // $and: [
      //   { creditLimit: { $exists: true } },
      //   { creditLimit: { $ne: null } },
      //   { creditLimit: { $ne: 0 } },
      // ],
    };
    if (requestedQuery.debtorIds) {
      let debtorIds = requestedQuery.debtorIds.split(',');
      if (isForDownload) {
        const debtors = await Debtor.find({ _id: { $in: debtorIds } })
          .select('entityName')
          .lean();
        filterArray.push({
          label: 'Debtor',
          value: debtors
            .map((i) => i.entityName)
            .toString()
            .replace(/,/g, ', '),
          type: 'string',
        });
      }
      debtorIds = debtorIds.map((id) => mongoose.Types.ObjectId(id));
      queryFilter.debtorId = { $in: debtorIds };
    }
    const aggregationQuery = [
      {
        $lookup: {
          from: 'debtors',
          localField: 'debtorId',
          foreignField: '_id',
          as: 'debtorID',
        },
      },
      {
        $unwind: {
          path: '$debtorID',
        },
      },
    ];
    if (debtorColumn.includes('stakeHolder')) {
      aggregationQuery.push({
        $lookup: {
          from: 'debtor-directors',
          localField: 'debtorId',
          foreignField: 'debtorId',
          as: 'debtordirectorId',
        },
      });
      // aggregationQuery.push({
      //   $match: {
      //      "debtordirectorId.isDeleted": false
      //   }
      // });
    }
    if (requestedQuery.entityType) {
      aggregationQuery.push({
        $match: {
          'debtorID.entityType': requestedQuery.entityType,
        },
      });
      if (isForDownload) {
        filterArray.push({
          label: 'Entity Type',
          value: formatString(requestedQuery.entityType),
          type: 'string',
        });
      }
    }
    if (
      debtorColumn.includes('activeApplicationId') ||
      debtorColumn.includes('limitType') ||
      debtorColumn.includes('approvalType')
    ) {
      aggregationQuery.push(
        {
          $lookup: {
            from: 'applications',
            localField: 'activeApplicationId',
            foreignField: '_id',
            as: 'activeApplicationId',
          },
        },
        {
          $unwind: {
            path: '$activeApplicationId',
            // preserveNullAndEmptyArrays: true,
          },
        },
      );
    }
    if (requestedQuery.startDate || requestedQuery.endDate) {
      if (requestedQuery.startDate && requestedQuery.endDate)
        aggregationQuery.push({
          $match: {
            'activeApplicationId.expiryDate': {
              $gte: new Date(requestedQuery.startDate),
              $lte: new Date(requestedQuery.endDate),
            },
          },
        });
      else if (requestedQuery.startDate)
        aggregationQuery.push({
          $match: {
            'activeApplicationId.expiryDate': {
              $gte: new Date(requestedQuery.startDate),
            },
          },
        });
      else if (requestedQuery.endDate)
        aggregationQuery.push({
          $match: {
            'activeApplicationId.expiryDate': {
              $lte: new Date(requestedQuery.endDate),
            },
          },
        });
    }
    const fields = debtorColumn.map((i) => {
      i = clientDebtorDetails.includes(i)
        ? i
        : applicationDetails.includes(i) && i !== 'activeApplicationId'
        ? 'activeApplicationId.' + i
        : i === 'activeApplicationId'
        ? 'activeApplicationId.applicationId'
        : i === 'stakeHolder'
        ? 'debtordirectorId.entityName'
        : 'debtorID.' + i;
      return [i, 1];
    });
    fields.push(['debtordirectorId.title', 1]);
    fields.push(['debtordirectorId.firstName', 1]);
    fields.push(['debtordirectorId.middleName', 1]);
    fields.push(['debtordirectorId.lastName', 1]);
    fields.push(['debtorID._id', 1]);
    fields.push(['activeApplicationId._id', 1]);
    fields.push(['activeApplicationId.expiryDate', 1]);
    fields.push(['activeApplicationId.clientReference', 1]);
    fields.push(['activeApplicationId.comments', 1]);
    fields.push(['activeApplicationId.creditLimit', 1]);
    aggregationQuery.push({
      $project: fields.reduce((obj, [key, val]) => {
        obj[key] = val;
        return obj;
      }, {}),
    });
    if (requestedQuery.search) {
      aggregationQuery.push({
        $match: {
          'debtorID.entityName': {
            $regex: getRegexForSearch(requestedQuery.search),
            $options: 'i',
          },
        },
      });
    }

    const sortingOptions = {};
    if (requestedQuery.sortBy && requestedQuery.sortOrder) {
      requestedQuery.sortBy = !clientDebtorDetails.includes(
        requestedQuery.sortBy,
      )
        ? 'debtorID.' + requestedQuery.sortBy
        : requestedQuery.sortBy === 'activeApplicationId'
        ? 'activeApplicationId._id'
        : requestedQuery.sortBy;
      sortingOptions[requestedQuery.sortBy] =
        requestedQuery.sortOrder === 'desc' ? -1 : 1;
      aggregationQuery.push({ $sort: sortingOptions });
    } else {
      requestedQuery.sortBy = '_id';
      sortingOptions[requestedQuery.sortBy] =
        requestedQuery.sortOrder === 'desc' ? 1 : -1;
      aggregationQuery.push({ $sort: sortingOptions });
    }

    if (requestedQuery.page && requestedQuery.limit) {
      aggregationQuery.push({
        $facet: {
          paginatedResult: [
            {
              $skip:
                (parseInt(requestedQuery.page) - 1) *
                parseInt(requestedQuery.limit),
            },
            { $limit: parseInt(requestedQuery.limit) },
          ],
          totalCount: [
            {
              $count: 'count',
            },
          ],
        },
      });
    }
    aggregationQuery.unshift({ $match: queryFilter });

    const debtors = await ClientDebtor.aggregate(aggregationQuery).allowDiskUse(
      true,
    );

    const response =
      debtors && debtors[0] && debtors[0]['paginatedResult']
        ? debtors[0]['paginatedResult']
        : debtors;

    if (isForDownload) {
      let endorsedLimits = 0;
      let creditChecks = 0;
      let creditChecksNZ = 0;
      response.forEach((debtor) => {
        if (debtor?.activeApplicationId?.limitType) {
          debtor.limitType =
            formatString(debtor.activeApplicationId?.limitType) || '';
          debtor.activeApplicationId.limitType === 'ENDORSED'
            ? endorsedLimits++
            : debtor.activeApplicationId.limitType === 'CREDIT_CHECK'
            ? creditChecks++
            : debtor.activeApplicationId.limitType === 'CREDIT_CHECK_NZ'
            ? creditChecksNZ++
            : null;
        }
        debtor.approvalType = StaticData.approvalType
        .find((i) => i._id === debtor.activeApplicationId.approvalType )?.name;
        debtor.approvalOrDecliningDate =
          debtor?.activeApplicationId?.approvalOrDecliningDate || '';
        debtor.requestedAmount = debtor?.activeApplicationId?.creditLimit || '';
        debtor.expiryDate = debtor?.activeApplicationId?.expiryDate || '';
        debtor.clientReference =
          debtor?.activeApplicationId?.clientReference || '';
        debtor.comments = debtor?.activeApplicationId?.comments || '';

        if (debtor.debtorID) {
          delete debtor.debtorID._id;
          for (let key in debtor.debtorID) {
            debtor[key] = debtor.debtorID[key];
          }
          delete debtor.debtorID;
        }
        if (debtor.debtordirectorId) {
          debtor.stakeHolder = '';
          debtor.debtordirectorId.map((i, index) => {
            debtor.stakeHolder +=
              `${i.entityName ? i.entityName : ''}` +
              `${i.title ? i.title + '.' : ''}` +
              `${i.firstName ? i.firstName + ' ' : ''}` +
              `${i.middleName ? i.middleName + ' ' : ''}` +
              `${i.lastName ? i.lastName : ''}`;
            if (index != debtor.debtordirectorId.length - 1) {
              debtor.stakeHolder += ', ';
            }
          });
        }
        delete debtor.debtordirectorId;
        debtor.entityType = formatString(debtor?.entityType);
        debtor.country = debtor?.address?.country?.name || '';
        delete debtor.address;
        delete debtor.activeApplicationId;
      });
      filterArray.push(
        {
          label: 'Endorsed Limits',
          value: endorsedLimits,
          type: 'string',
        },
        { label: 'Credit Checks', value: creditChecks, type: 'string' },
        { label: 'Credit Checks NZ', value: creditChecksNZ, type: 'string' },
      );
      return {
        docs: response,
        filterArray,
      };
    } else {
      const total =
        debtors.length !== 0 &&
        debtors[0]['totalCount'] &&
        debtors[0]['totalCount'].length !== 0
          ? debtors[0]['totalCount'][0]['count']
          : 0;

      const headers = [];
      if (!sendAsHeader) {
        const index = debtorColumn.indexOf('limitType');
        if (index > -1) {
          debtorColumn.splice(index, 1);
        }
      }
      if (!sendLimitAsHeader) {
        const index = debtorColumn.indexOf('creditLimit');
        if (index > -1) {
          debtorColumn.splice(index, 1);
        }
      }
      for (let i = 0; i < moduleColumn.length; i++) {
        if (debtorColumn.includes(moduleColumn[i].name)) {
          if (
            ((hasOnlyReadAccessForDebtorModule || !isForRisk) &&
              moduleColumn[i].name === 'entityName') ||
            (hasOnlyReadAccessForApplicationModule &&
              moduleColumn[i].name === 'activeApplicationId')
          ) {
            headers.push({
              name: moduleColumn[i].name,
              label: moduleColumn[i].label,
              type: 'string',
            });
          } else {
            headers.push(moduleColumn[i]);
          }
        }
      }

      response.forEach((debtor) => {
        if (debtor.activeApplicationId?.limitType) {
          debtor.limitType = formatString(debtor.activeApplicationId.limitType);
        }
        if (debtor.activeApplicationId?.expiryDate !== undefined) {
          debtor.expiryDate = debtor.activeApplicationId.expiryDate;
        }
        if (debtor.activeApplicationId?.creditLimit !== undefined) {
          // debtor.creditLimit = debtor.activeApplicationId.creditLimit;
        }
        if (debtor.activeApplicationId?.approvalOrDecliningDate) {
          debtor.approvalOrDecliningDate =
            debtor.activeApplicationId.approvalOrDecliningDate;
        }
        if (debtor.activeApplicationId?.approvalType) {
          debtor.approvalType = StaticData.approvalType
          .find((i) => i._id === debtor.activeApplicationId.approvalType )?.name;
        }
        if (debtor.activeApplicationId?.applicationId) {
          debtor.activeApplicationId = hasOnlyReadAccessForApplicationModule
            ? debtor.activeApplicationId.applicationId
            : {
                _id: debtor.activeApplicationId._id,
                value: debtor.activeApplicationId.applicationId,
              };
        }
        if (debtor.debtorID) {
          delete debtor.debtorID._id;
          for (let key in debtor.debtorID) {
            debtor[key] = debtor.debtorID[key];
          }
          delete debtor.debtorID;
        }
        if (debtor.entityType) {
          debtor.entityType = formatString(debtor.entityType);
        }
        if (debtor.debtordirectorId) {
          debtor.stakeHolder = '';
          debtor.debtordirectorId.map((i, index) => {
            debtor.stakeHolder +=
              `${i.entityName ? i.entityName : ''}` +
              `${i.title ? i.title + '.' : ''}` +
              `${i.firstName ? i.firstName + ' ' : ''}` +
              `${i.middleName ? i.middleName + ' ' : ''}` +
              `${i.lastName ? i.lastName : ''}`;
            if (index != debtor.debtordirectorId.length - 1) {
              debtor.stakeHolder += ', ';
            }
          });
          delete debtor.debtordirectorId;
        }
        if (
          debtor.entityName &&
          isForRisk &&
          !hasOnlyReadAccessForDebtorModule
        ) {
          debtor.entityName = {
            id: debtor._id,
            value: debtor.entityName,
          };
        }
        /*if (debtor.hasOwnProperty('isEndorsedLimit')) {
          debtor.isEndorsedLimit = debtor.isEndorsedLimit
            ? 'Endorsed'
            : 'Assessed';
        }*/
      });
      return {
        docs: response,
        headers,
        total,
        page: parseInt(requestedQuery.page),
        limit: parseInt(requestedQuery.limit),
        pages: Math.ceil(total / parseInt(requestedQuery.limit)),
      };
    }
  } catch (e) {
    Logger.log.error('Error occurred in get client credit-limit list');
    Logger.log.error(e.message || e);
  }
};

const getDebtorCreditLimit = async ({
  debtorColumn,
  requestedQuery,
  moduleColumn,
  debtorId,
  hasOnlyReadAccessForClientModule = false,
  hasOnlyReadAccessForApplicationModule = false,
  hasFullAccessForClientModule,
  userId,
  clientId = null,
}) => {
  try {
    let sendAsHeader = true;
    let sendLimitAsHeader = true;
    debtorColumn.push('isFromOldSystem');
    if (!debtorColumn.includes('limitType')) {
      sendAsHeader = false;
      debtorColumn.push('limitType');
    }
    if (!debtorColumn.includes('creditLimit')) {
      sendLimitAsHeader = false;
      debtorColumn.push('creditLimit');
    }
    const clientDebtorDetails = [
      'creditLimit',
      'expiryDate',
      'isFromOldSystem',
      'createdAt',
      'updatedAt',
    ];
    const applicationDetails = [
      'limitType',
      'expiryDate',
      'approvalOrDecliningDate',
      'activeApplicationId',
      'approvalType'
    ];
    const queryFilter = {
      // isActive: true,
      debtorId: mongoose.Types.ObjectId(debtorId),
      status: { $exists: true, $in: ['APPROVED', 'DECLINED'] },
      // creditLimit: { $exists: true, $ne: null },
      // $and: [
      //   { creditLimit: { $exists: true } },
      //   { creditLimit: { $ne: null } },
      //   { creditLimit: { $ne: 0 } },
      // ],
    };
    if (!hasFullAccessForClientModule && userId) {
      const clients = await Client.find({
        $or: [{ riskAnalystId: userId }, { serviceManagerId: userId }],
      })
        .select('_id')
        .lean();
      if (clients?.length !== 0) {
        queryFilter.clientId = { $in: clients.map((i) => i._id) };
      }
    }
    if (clientId) {
      queryFilter.clientId = clientId;
    }
    const aggregationQuery = [
      {
        $lookup: {
          from: 'clients',
          localField: 'clientId',
          foreignField: '_id',
          as: 'clientId',
        },
      },
      {
        $unwind: {
          path: '$clientId',
        },
      },
    ];
    if (
      debtorColumn.includes('activeApplicationId') ||
      debtorColumn.includes('limitType') ||
      debtorColumn.includes('approvalType')
    ) {
      aggregationQuery.push(
        {
          $lookup: {
            from: 'applications',
            localField: 'activeApplicationId',
            foreignField: '_id',
            as: 'activeApplicationId',
          },
        },
        {
          $unwind: {
            path: '$activeApplicationId',
            // preserveNullAndEmptyArrays: true,
          },
        },
      );
    }
    const fields = debtorColumn.map((i) => {
      // i = !clientDebtorDetails.includes(i) ? 'clientId.' + i : i;
      i = clientDebtorDetails.includes(i)
        ? i
        : applicationDetails.includes(i) && i !== 'activeApplicationId'
        ? 'activeApplicationId.' + i
        : i === 'activeApplicationId'
        ? 'activeApplicationId.applicationId'
        : 'clientId.' + i;
      return [i, 1];
    });

    fields.push(['activeApplicationId._id', 1]);
    fields.push(['activeApplicationId.expiryDate', 1]);
    fields.push(['activeApplicationId.approvalOrDecliningDate', 1]);
    if (debtorColumn.includes('name')) {
      fields.push(['clientId._id', 1]);
    }
    aggregationQuery.push({
      $project: fields.reduce((obj, [key, val]) => {
        obj[key] = val;
        return obj;
      }, {}),
    });

    if (requestedQuery.search) {
      aggregationQuery.push({
        $match: {
          'clientId.name': {
            $regex: getRegexForSearch(requestedQuery.search),
            $options: 'i',
          },
        },
      });
    }

    const sortingOptions = {};
    if (requestedQuery.sortBy && requestedQuery.sortOrder) {
      requestedQuery.sortBy = !clientDebtorDetails.includes(
        requestedQuery.sortBy,
      )
        ? 'clientId.' + requestedQuery.sortBy
        : requestedQuery.sortBy === 'activeApplicationId'
        ? 'activeApplicationId._id'
        : requestedQuery.sortBy;
      sortingOptions[requestedQuery.sortBy] =
        requestedQuery.sortOrder === 'desc' ? -1 : 1;
      aggregationQuery.push({ $sort: sortingOptions });
    }

    if (requestedQuery.page && requestedQuery.limit) {
      aggregationQuery.push({
        $facet: {
          paginatedResult: [
            {
              $skip:
                (parseInt(requestedQuery.page) - 1) *
                parseInt(requestedQuery.limit),
            },
            { $limit: parseInt(requestedQuery.limit) },
          ],
          totalCount: [
            {
              $count: 'count',
            },
          ],
        },
      });
    }
    aggregationQuery.unshift({ $match: queryFilter });

    const debtors = await ClientDebtor.aggregate(aggregationQuery).allowDiskUse(
      true,
    );

    const response =
      debtors && debtors[0] && debtors[0]['paginatedResult']
        ? debtors[0]['paginatedResult']
        : debtors;

    const total =
      debtors.length !== 0 &&
      debtors[0]['totalCount'] &&
      debtors[0]['totalCount'].length !== 0
        ? debtors[0]['totalCount'][0]['count']
        : 0;

    const headers = [];
    if (!sendAsHeader) {
      const index = debtorColumn.indexOf('limitType');
      if (index > -1) {
        debtorColumn.splice(index, 1);
      }
    }
    if (!sendLimitAsHeader) {
      const index = debtorColumn.indexOf('creditLimit');
      if (index > -1) {
        debtorColumn.splice(index, 1);
      }
    }
    for (let i = 0; i < moduleColumn.length; i++) {
      if (debtorColumn.includes(moduleColumn[i].name)) {
        if (
          (hasOnlyReadAccessForClientModule &&
            moduleColumn[i].name === 'name') ||
          (hasOnlyReadAccessForApplicationModule &&
            moduleColumn[i].name === 'activeApplicationId')
        ) {
          headers.push({
            name: moduleColumn[i].name,
            label: moduleColumn[i].label,
            type: 'string',
          });
        } else {
          headers.push(moduleColumn[i]);
        }
      }
    }
    response.forEach((debtor) => {
      if (debtor.activeApplicationId?.limitType) {
        debtor.limitType = formatString(debtor.activeApplicationId.limitType);
      }
      if (debtor.activeApplicationId?.expiryDate) {
        debtor.expiryDate = debtor.activeApplicationId.expiryDate;
      } else {
        const date = new Date();
        let expiryDate = new Date(date.setMonth(date.getMonth() + 12));
        expiryDate = new Date(expiryDate.setDate(expiryDate.getDate() - 1));

        debtor.expiryDate = expiryDate;
      }
      if (debtor.activeApplicationId?.approvalOrDecliningDate) {
        debtor.approvalOrDecliningDate =
          debtor.activeApplicationId.approvalOrDecliningDate;
      }
      if (debtor.activeApplicationId?.approvalType) {
        debtor.approvalType = StaticData.approvalType
        .find((i) => i._id === debtor.activeApplicationId.approvalType )?.name;
      }
      if (debtor.activeApplicationId?.applicationId) {
        debtor.activeApplicationId = hasOnlyReadAccessForApplicationModule
          ? debtor.activeApplicationId.applicationId
          : {
              _id: debtor.activeApplicationId._id,
              value: debtor.activeApplicationId.applicationId,
            };
      }
      if (debtor.clientId && debtor.clientId.contactNumber) {
        debtor.contactNumber = debtor.clientId.contactNumber;
      }
      if (debtor.clientId && debtor.clientId.abn) {
        debtor.abn = debtor.clientId.abn;
      }
      if (debtor.clientId && debtor.clientId.acn) {
        debtor.acn = debtor.clientId.acn;
      }
      if (debtor.clientId.name) {
        debtor.name = hasOnlyReadAccessForClientModule
          ? debtor.clientId.name
          : {
              id: debtor.clientId._id,
              value: debtor.clientId.name,
            };
      }
      delete debtor.clientId;
    });
    return {
      docs: response,
      headers,
      total,
      page: parseInt(requestedQuery.page),
      limit: parseInt(requestedQuery.limit),
      pages: Math.ceil(total / parseInt(requestedQuery.limit)),
    };
  } catch (e) {
    Logger.log.error('Error occurred in get debtor credit-limit list', e);
    Logger.log.error(e.message || e);
  }
};

const formatCSVList = async ({ response, moduleColumn }) => {
  try {
    const finalArray = [];
    let data = {};
    response.forEach((i) => {
      data = {};
      moduleColumn.map((key) => {
        if (
          (key === 'entityName' ||
            key === 'activeApplicationId' ||
            key === 'name') &&
          i[key] &&
          i[key]['value']
        ) {
          i[key] = i[key]['value'];
        }
        if (
          (key === 'expiryDate' ||
            key === 'inceptionDate' ||
            key === 'createdAt' ||
            key === 'updatedAt') &&
          i[key]
        ) {
          i[key] =
            new Date(i[key]).getDate() +
            '-' +
            (new Date(i[key]).getMonth() + 1) +
            '-' +
            new Date(i[key]).getFullYear();
        }
        data[key] = i[key];
      });
      finalArray.push(data);
    });
    return finalArray;
  } catch (e) {
    Logger.log.error('Error occurred in format credit-limit list');
    Logger.log.error(e.message || e);
  }
};

const convertToCSV = (arr) => {
  const json2csvParser = new Parser();
  const csv = json2csvParser.parse(arr);
  return csv;
};

const checkForExpiringLimit = async ({ startDate, endDate }) => {
  try {
    const creditLimits = await ClientDebtor.find({
      expiryDate: { $exists: true, $ne: null, $gte: startDate, $lte: endDate },
      // isActive: true,
      status: { $exists: true, $in: ['APPROVED'] },
    })
      .populate({
        path: 'clientId',
        populate: { path: 'riskAnalystId' },
      })
      .populate('debtorId')
      .select('_id clientId debtorId')
      .lean();
    const response = [];
    creditLimits.forEach((i) => {
      if (
        i.clientId &&
        i.clientId.name &&
        i.clientId.riskAnalystId &&
        i.clientId.riskAnalystId._id &&
        i.debtorId &&
        i.debtorId._id &&
        i.debtorId.entityName
      ) {
        response.push({
          id: i.debtorId._id + i.clientId.riskAnalystId._id,
          clientName: i.clientId.name,
          debtorId: i.debtorId._id,
          debtorName: i.debtorId.entityName,
          riskAnalystId: i.clientId.riskAnalystId._id,
          creditLimitId: i._id,
        });
      }
    });
    const filteredData = Array.from(new Set(response.map((s) => s.id))).map(
      (id) => {
        return {
          id: id,
          clientName: response.find((i) => i.id === id).clientName,
          debtorId: response.find((i) => i.id === id).debtorId,
          debtorName: response.find((i) => i.id === id).debtorName,
          riskAnalystId: response.find((i) => i.id === id).riskAnalystId,
          creditLimitId: response.find((i) => i.id === id).creditLimitId,
        };
      },
    );
    for (let i = 0; i < filteredData.length; i++) {
      const notification = await addNotification({
        userId: filteredData[i].riskAnalystId,
        userType: 'user',
        description: `Credit limit for ${filteredData[i].clientName} - ${filteredData[i].debtorName} is expiring today`,
        entityType: 'credit-limit',
        entityId: filteredData[i]?.debtorId,
      });
      if (notification) {
        sendNotification({
          notificationObj: {
            type: 'CREDIT_LIMIT_EXPIRING',
            data: notification,
          },
          type: notification.userType,
          userId: notification.userId,
        });
      }
    }
  } catch (e) {
    Logger.log.error('Error occurred in check for expiring credit limit');
    Logger.log.error(e);
  }
};

const downloadDecisionLetter = async ({ creditLimitId }) => {
  try {
    const query = {
      _id: creditLimitId,
    };
    const clientDebtor = await ClientDebtor.findOne(query)
      .populate({
        path: 'clientId',
        populate: {
          path: 'serviceManagerId',
          select: 'name email contactNumber',
        },
      })
      .populate({
        path: 'debtorId',
        select: 'entityName registrationNumber abn acn address tradingName',
      })
      .populate('activeApplicationId')
      .lean();
    let bufferData;
    if (!clientDebtor?.isFromOldSystem) {
      /* } else {*/
      const response = {
        status:
          parseInt(clientDebtor.creditLimit) >
          parseInt(clientDebtor?.activeApplicationId?.creditLimit)
            ? 'PARTIALLY_APPROVED'
            : 'APPROVED',
        clientName:
          clientDebtor.clientId && clientDebtor.clientId.name
            ? clientDebtor.clientId.name
            : '',
        debtorName:
          clientDebtor.debtorId && clientDebtor.debtorId.entityName
            ? clientDebtor.debtorId.entityName
            : '',
        serviceManagerNumber:
          clientDebtor.clientId &&
          clientDebtor.clientId.serviceManagerId &&
          clientDebtor.clientId.serviceManagerId.contactNumber
            ? clientDebtor.clientId.serviceManagerId.contactNumber
            : '',
        requestedAmount: parseInt(
          clientDebtor?.activeApplicationId?.creditLimit,
        ).toFixed(2),
        approvedAmount: clientDebtor?.activeApplicationId?.acceptedAmount?.toFixed(
          2,
        ),
        approvalStatus: clientDebtor?.activeApplicationId?.comments,
        country: clientDebtor?.debtorId?.address?.country?.code,
        tradingName: clientDebtor?.debtorId?.tradingName,
        requestedDate: clientDebtor?.activeApplicationId?.requestDate,
        approvalOrDecliningDate:
          clientDebtor?.activeApplicationId?.approvalOrDecliningDate,
        expiryDate: clientDebtor?.activeApplicationId?.expiryDate,
      };
      if (response.country === 'AUS' || response.country === 'NZL') {
        response.abn = clientDebtor?.debtorId?.abn;
        response.acn = clientDebtor?.debtorId?.acn;
      } else {
        response.registrationNumber =
          clientDebtor?.debtorId?.registrationNumber;
      }
      const application = await Application.findOne({
        _id: clientDebtor.activeApplicationId._id,
      });
      if (application.limitType === 'CREDIT_CHECK_NZ') {
        response.isCreditCheckOrNZ = 'Credit Check NZ';
      } else {
        response.isCreditCheckOrNZ = 'Credit Check';
      }
      bufferData = await generateDecisionLetter(response);
    }
    return {
      applicationNumber: clientDebtor?.activeApplicationId?.applicationId,
      bufferData,
    };
  } catch (e) {
    Logger.log.error('Error occurred in download decision letter', e);
  }
};

const downloadDecisionLetterFromApplication = async ({ applicationId }) => {
  try {
    const query = {
      _id: applicationId,
    };
    const application = await Application.findOne(query)
      .populate({
        path: 'clientId',
        populate: {
          path: 'serviceManagerId',
          select: 'name email contactNumber',
        },
      })
      .populate({
        path: 'debtorId',
        select:
          'entityName registrationNumber abn acn address tradingName limitType status',
      })
      .lean();
    let bufferData;
    if (!application?.isApprovedFromOldSystem) {
      const response = {
        status:
          application.status === 'DECLINED'
            ? 'DECLINED'
          :parseInt(application.acceptedAmount) >
          parseInt(application?.creditLimit)
            ? 'PARTIALLY_APPROVED'
            : 'APPROVED',
        clientName:
          application.clientId && application.clientId.name
            ? application.clientId.name
            : '',
        debtorName:
          application.debtorId && application.debtorId.entityName
            ? application.debtorId.entityName
            : '',
        serviceManagerNumber:
          application.clientId &&
          application.clientId.serviceManagerId &&
          application.clientId.serviceManagerId.contactNumber
            ? application.clientId.serviceManagerId.contactNumber
            : '',
        requestedAmount: parseInt(application?.creditLimit).toFixed(2),
        approvedAmount: application?.acceptedAmount?.toFixed(2),
        approvalStatus: application?.comments,
        approvalType: application?.approvalType,
        country: application?.debtorId?.address?.country?.code,
        clientReference: application?.clientReference,
        tradingName: application?.debtorId?.tradingName,
        requestedDate: application?.requestDate,
        approvalOrDecliningDate: application?.approvalOrDecliningDate,
        expiryDate: application?.expiryDate,
      };
      if (application.approvalType) {
        response.approvalType = StaticData.approvalType
        .find((i) => i._id === application.approvalType ).name
      }
      if (response.country === 'AUS' || response.country === 'NZL') {
        response.abn = application?.debtorId?.abn;
        response.acn = application?.debtorId?.acn;
      } else {
        response.registrationNumber = application?.debtorId?.registrationNumber;
      }
      if (application.limitType === 'CREDIT_CHECK_NZ') {
        response.isCreditCheckOrNZ = 'New Zealand Credit Check';
      } else {
        response.isCreditCheckOrNZ = 'Credit Check';
      }
      bufferData = await generateDecisionLetter(response);
    }
    return {
      applicationNumber: application?.applicationId,
      bufferData,
    };
  } catch (e) {
    Logger.log.error('Error occurred in download decision letter', e);
  }
};

const updateActiveReportInCreditLimit = async ({ reportDetails, debtorId }) => {
  try {
    const reportCodes = {
      HXBSC: ['HXBCA', 'HXPAA', 'HXPYA'],
      HXBCA: ['HXPAA', 'HXPYA'],
      HXPYA: ['HXPAA'],
      HNBCau: ['NPA'],
    };
    const activeCreditLimit = await ClientDebtor.findOne({
      isActive: true,
      debtorId: mongoose.Types.ObjectId(debtorId),
      $and: [
        { creditLimit: { $exists: true } },
        { creditLimit: { $ne: null } },
        { creditLimit: { $ne: 0 } },
        { currentReportId: { $exists: true } },
        { currentReportId: { $ne: null } },
      ],
    })
      .populate('currentReportId')
      .lean();
    if (activeCreditLimit && activeCreditLimit?.currentReportId) {
      if (
        activeCreditLimit.currentReportId?.productCode &&
        reportCodes[activeCreditLimit.currentReportId.productCode]?.includes(
          reportDetails.productCode,
        )
      ) {
        await ClientDebtor.updateMany(
          {
            isActive: true,
            debtorId: mongoose.Types.ObjectId(debtorId),
            $and: [
              { creditLimit: { $exists: true } },
              { creditLimit: { $ne: null } },
              { creditLimit: { $ne: 0 } },
            ],
          },
          { currentReportId: reportDetails._id },
        );
      }
    } else {
      await ClientDebtor.updateMany(
        {
          isActive: true,
          debtorId: mongoose.Types.ObjectId(debtorId),
          $and: [
            { creditLimit: { $exists: true } },
            { creditLimit: { $ne: null } },
            { creditLimit: { $ne: 0 } },
          ],
        },
        { currentReportId: reportDetails._id },
      );
    }
  } catch (e) {
    Logger.log.error(
      'Error occurred in update credit report ion credit limit',
      e.message || e,
    );
  }
};

module.exports = {
  getClientDebtorDetails,
  convertToCSV,
  getClientCreditLimit,
  getDebtorCreditLimit,
  formatCSVList,
  checkForExpiringLimit,
  downloadDecisionLetter,
  updateActiveReportInCreditLimit,
  downloadDecisionLetterFromApplication,
};
