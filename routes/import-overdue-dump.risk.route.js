/*
 * Module Imports
 * */
const express = require('express');
const router = express.Router();
const multer = require('multer');
let mongoose = require('mongoose');
const ImportOverdueDump = mongoose.model('import-overdue-dump');

/*
 * Local Imports
 * */
const Logger = require('../services/logger');
const {
  readExcelFile,
  processAndValidateOverdues,
  updateList,
} = require('../helper/import-overdue-dump.helper');
const StaticFileHelper = require('../helper/static-file.helper');
const StaticFile = require('./../static-files/moduleColumn');

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

/*
 * Upload new import file
 * */
router.post('/', upload.single('dump-file'), async function (req, res) {
  if (!req.file.buffer) {
    return res.status(400).send({
      status: 'ERROR',
      messageCode: 'REQUIRE_FIELD_MISSING',
      message: 'Require fields are missing',
    });
  }
  try {
    const dateString = req.body.period;
    const [monthString, yearString] = dateString.split('-');
    const month = new Date(`${monthString} 1, 2000`).getMonth() + 1;
    const year = parseInt(yearString);

    let helperResponse = await readExcelFile(req.file.buffer);
    if (!helperResponse.isImportCompleted) {
      return res.status(400).send({
        status: 'ERROR',
        messageCode: 'REQUIRE_FIELD_MISSING',
        message: helperResponse.reasonForInCompletion,
      });
    } else {
      const module = StaticFile.modules.find(
        (i) => i.name === 'import-overdue',
      );
      let responseBody = {
        headers: module.manageColumns,
        docs: helperResponse.unProcessedOverdues,
        toBeProcessedOverdueCount: helperResponse.overdues.length,
      };
      let importOverdueDump = new ImportOverdueDump({
        overdues: helperResponse.overdues,
        clientId: req.body.clientId,
        nilOverdue: false,
        oldNilOverdue: false,
        month: month,
        year: year,
      });
      await importOverdueDump.save();
      responseBody.importId = importOverdueDump._id;
      res.status(200).send({
        status: 'SUCCESS',
        data: responseBody,
      });
    }
  } catch (e) {
    Logger.log.error(
      'Error occurred in upload new import overdues file',
      e.message || e,
    );
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

/*
 * Update import file module
 * */
router.put('/:importId', async function (req, res) {
  if (!req.params.importId || !req.query.stepName) {
    return res.status(400).send({
      status: 'ERROR',
      messageCode: 'REQUIRE_FIELD_MISSING',
      message: 'Require fields are missing',
    });
  }
  try {
    const module = StaticFile.modules.find((i) => i.name === 'import-overdue');
    let responseBody;
    let helperResponse;
    switch (req.query.stepName) {
      case 'VALIDATE_OVERDUES':
        helperResponse = await processAndValidateOverdues(req.params.importId);
        await ImportOverdueDump.updateOne(
          {
            _id: req.params.importId,
          },
          {
            overdues: helperResponse.overdues,
            currentStepIndex: 'VALIDATED',
          },
        );
        responseBody = {
          headers: module.manageColumns,
          docs: helperResponse.unProcessedOverdues,
          toBeProcessedOverdueCount: helperResponse.overdues.length,
        };
        break;
      case 'GENERATE_OVERDUES':
        const importOverdueDump = await ImportOverdueDump.findOne({
          _id: req.params.importId,
        });
        let response;
        try {
          if (!importOverdueDump.overdues || importOverdueDump.overdues.length === 0) {
            return res.status(400).send({
              status: 'ERROR',
              messageCode: 'REQUIRE_FIELD_MISSING',
              message: 'Require fields are missing.',
            });
          }
          const overdueArr = importOverdueDump.overdues.map((i) => {
            return (
              importOverdueDump.clientId +
              (i.debtorId ? i.debtorId : i.acn) +
              importOverdueDump.month.toString().padStart(2, '0') +
              importOverdueDump.year
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
          response = await updateList({
            isForRisk: true,
            importOverdueDump: importOverdueDump,
            userId: req.user._id,
            userName: req.user.name,
            userType: 'user',
          });
          if (response && response.status && response.status === 'ERROR') {
            return res.status(400).send(response);
          }
        } catch (e) {
          Logger.log.error('Error occurred in save overdue list', e.message || e);
          res.status(500).send({
            status: 'ERROR',
            message: e.message || 'Something went wrong, please try again later.',
          });
        }

        await ImportOverdueDump.updateOne(
          {
            _id: req.params.importId,
          },
          {
            currentStepIndex: 'PROCESSED',
          },
        );

        responseBody = {
          status: 'SUCCESS',
          headers: module.manageColumns,
          docs: response.unProcessedOverdues,
          message: 'Import completed.',
        };
        break;
    }
    res.status(200).send({
      status: 'SUCCESS',
      data: responseBody,
    });
  } catch (e) {
    Logger.log.error(
      'Error occurred in update import file module',
      e.message || e,
    );
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

/*
 * Delete import file
 * */
router.delete('/:importId', async function (req, res) {
  if (!req.params.importId) {
    return res.status(400).send({
      status: 'ERROR',
      messageCode: 'REQUIRE_FIELD_MISSING',
      message: 'Require fields are missing',
    });
  }
  try {
    await ImportOverdueDump.deleteOne({ _id: req.params.importId });
    res.status(200).send({
      status: 'SUCCESS',
      message: 'Import dump deleted successfully.',
    });
  } catch (e) {
    Logger.log.error('Error occurred in delete file module', e.message || e);
    res.status(500).send({
      status: 'ERROR',
      message: e.message || 'Something went wrong, please try again later.',
    });
  }
});

/*
 * Get Sample Excel File from S3
 * */
router.get('/sample-file', async function (req, res) {
  try {
    const fileBuffer = await StaticFileHelper.downloadDocument({
      filePath: 'static-files/overdue-dump/Import_Overdues.xlsx',
    });
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=' + 'Import_Overdues.xlsx',
    );
    return fileBuffer.pipe(res);
  } catch (e) {
    Logger.log.error(
      'Error occurred in get Sample Excel File from S3',
      e.message || e,
    );
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
