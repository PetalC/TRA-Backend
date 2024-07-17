/*
 * Module Imports
 * */
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = mongoose.model('user');
const ClientUser = mongoose.model('client-user');
const Insurer = mongoose.model('insurer');
const Organization = mongoose.model('organization');

/*
 * Local Imports
 * */
const config = require('../config');
const MailHelper = require('./mailer.helper');
const Logger = require('../services/logger');
const StaticFile = require('./../static-files/systemModules');
const { createProfile } = require('./illion.helper');

const createSuperAdmin = () => {
  return new Promise(async (resolve, reject) => {
    try {
      let superAdmin = await User.findOne({ email: config.superAdmin.email });
      if (superAdmin) {
        Logger.log.info('Super admin already exists.');
        return resolve();
      }
      let user = new User({
        role: 'superAdmin',
        name: 'Super Admin User',
        email: config.superAdmin.email,
        password: config.superAdmin.password,
        profilePicture: null,
      });
      let organization = await Organization.findOne({ isDeleted: false });
      if (!organization) {
        organization = new Organization({
          name: config.organization.name,
          integration: {
            rss: {
              accessToken:
                'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6ImFhY2VlYzlhNWRlNWI2OTVjZGU3ZWMzNjlhMDA5NzVlMDhhYjU2NTFkZDA0YjM4MmJkOGQ1ZTk1MjRjYjcxNDUyNzE4NmJlYWRmYjliNTIxIn0.eyJhdWQiOiI3IiwianRpIjoiYWFjZWVjOWE1ZGU1YjY5NWNkZTdlYzM2OWEwMDk3NWUwOGFiNTY1MWRkMDRiMzgyYmQ4ZDVlOTUyNGNiNzE0NTI3MTg2YmVhZGZiOWI1MjEiLCJpYXQiOjE2NzU4NTAyMjksIm5iZiI6MTY3NTg1MDIyOSwiZXhwIjoxNzA3Mzg2MjI5LCJzdWIiOiI4NjQiLCJzY29wZXMiOltdfQ.Up4rA-nRg-Xfc0OaK-0Gy54TbS8k-2A7TZz9Q1ujnu_acNzVr8debYJuENsrFvp7trLByAYAMG1_7lXGqhvq60ujn1GT2tLFHjttI1Kq0h3t3WO6qNvfEUolM1PWHrfkaH2nwuHqB1IqQNHDwSZkyFUfhOtq_yKhRLJ3FEYUUvxtA_Mu8SlgBgdbbDvaY5Nj5SraVAHflVa_kNUjDxIgRDxsSwMyoCKaGMCUg-UCWLdUYjYkfRxoWUumelJOJhCzogbEvK_Xm_cJyLk1OGlr99wGgS_jt0wnXBeuhgIkQ-zh8UxKtR3KJNscubmiWGoJyxDFP6lqI0-r58RKy1KO6V2_YBRs87Pl-A_pxk7QXv-A21YVRJB-iX1MbePwaCsR1xClpURNY7IZI-v03oxHv7R36Z7mifin_Z7C_ro4vzN_lMEL8nT2amQSETSByGnNhGuTX3b2-Tr-X2hdYxdbApJ2Sbugd9W2JTI-uEy5TMoZWVKjEb3PrkQ6oy6oLuYYpx__kwj_8LrBdp3Q868EG_-Hytl-_2KC71ZOQFVmDOwHUXezjPwmwfIGaAUW6x7rTevNAsr1bUfSpuHkY1moEtLiirELZ6N2Mqqt20VlGKkRy1Jb8eu3Dca7JeXR2MxxqD_fmXvywPHtwmIpL6lNA9NtBruSzcxm4YczAWtuUqo',
            },
            abn: {
              guid: '2d068418-c48d-4b66-9c59-457260bea2e5',
            },
            illion: {
              password: 'VNpioW4C',
              subscriberId: '940781772',
              userId: '001016',
            },
            nzbn: {
              accessToken: '5d54587d33c04a87ab3ecd67e8fbd3f0',
            },
            illionAlert: {
              subscriberId: '940781772',
              userId: '001016',
              password: 'VNpioW4C',
            },
          },
          address: 'Suite 11, 857 Doncaster Road Doncaster East, Victoria 3109',
        });
      }
      await organization.save();
      let signUpToken = jwt.sign(
        JSON.stringify({ _id: user._id }),
        config.jwt.secret,
      );
      user.signUpToken = signUpToken;
      user.organizationId = organization._id;
      user.moduleAccess = StaticFile.modules;
      user.manageColumns = [
        {
          moduleName: 'user',
          columns: [
            'name',
            'email',
            'contactNumber',
            'role',
            'maxCreditLimit',
            'updatedAt',
          ],
        },
        {
          moduleName: 'client',
          columns: [
            'clientCode',
            'name',
            'contactNumber',
            'riskAnalystId',
            'serviceManagerId',
            'insurerId',
            'fullAddress',
            'addressLine',
            'city',
            'state',
            'country',
            'zipCode',
            'website',
            'sector',
            'abn',
            'acn',
            'expiryDate',
          ],
        },
      ];
      await user.save();
      let mailObj = {
        toAddress: [user.email],
        subject: 'Welcome to TCR',
        text: {
          name: user.name ? user.name : '',
          setPasswordLink:
            config.server.frontendUrls.adminPanelBase +
            config.server.frontendUrls.setPasswordPage +
            user._id +
            '?token=' +
            signUpToken,
        },
        mailFor: 'newAdminUser',
      };
      await MailHelper.sendMail(mailObj);
      Logger.log.info('SuperAdmin created successfully.');
      return resolve();
    } catch (e) {
      Logger.log.error('Error occurred.', e.message || e);
      return reject(e);
    }
  });
};

const createDefaultInsurer = () => {
  return new Promise(async (resolve, reject) => {
    try {
      const defaultInsurer = await Insurer.findOne({
        name: config.organization.insurerName,
      }).lean();
      if (defaultInsurer) {
        Logger.log.info('Insurer already exists');
        return resolve();
      }
      const insurer = new Insurer({
        name: config.organization.insurerName,
        isDefault: true,
      });
      await insurer.save();
      Logger.log.info('Insurer created successfully');
      return resolve();
    } catch (e) {
      Logger.log.error('Error occurred in create insurer ', e.message || e);
      return reject(e);
    }
  });
};

const checkForIllionProfile = async () => {
  try {
    const organization = await Organization.findOne({
      isDeleted: false,
    }).lean();
    if (
      !organization.illionAlertProfile ||
      !organization.illionAlertProfile.profileId
    ) {
      const alertIds = [
        1,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        12,
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        20,
        21,
        47,
        48,
        49,
        121,
        122,
        276,
        277,
        278,
        292,
        293,
        294,
      ];
      if (
        organization.integration.illionAlert &&
        organization.integration.illionAlert.userId &&
        organization.integration.illionAlert.password &&
        organization.integration.illionAlert.subscriberId
      ) {
        const response = await createProfile({
          illionAlert: organization.integration.illionAlert,
          alertIds,
          profileName: organization.name,
        });
        if (response && response.profile) {
          await Organization.updateOne(
            { isDeleted: false },
            { $set: { illionAlertProfile: response.profile } },
          );
        }
      }
    } else {
      Logger.log.info('Illion profile already exists.');
    }
  } catch (e) {
    Logger.log.error('Error occurred in check for illion profile');
    Logger.log.error(e.message || e);
  }
};

module.exports = {
  createSuperAdmin,
  createDefaultInsurer,
  checkForIllionProfile,
};
