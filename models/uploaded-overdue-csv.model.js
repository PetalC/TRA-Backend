/*
 * Module Imports
 * */
const mongoose = require('mongoose');
const pagination = require('mongoose-paginate');
const Schema = mongoose.Schema;

/**
 * Schema Definition
 */
const uploadedOverdueCsvSchema = new Schema(
  {
    submittedById: { type: Schema.Types.ObjectId, ref:'client-user' },
    submittedByType: {
      type: Schema.Types.String,
      enum: ['client-user', 'user'],
    },
  },
  { timestamps: true },
);

uploadedOverdueCsvSchema.plugin(pagination);

/**
 * Export Schema
 */
module.exports = mongoose.model(
  'uploaded-overdue-csv',
  uploadedOverdueCsvSchema,
);
