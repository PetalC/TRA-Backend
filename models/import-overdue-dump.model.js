/*
 * Module Imports
 * */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Schema Definition
 */
const importOverdueDumpSchema = new Schema(
  {
    overdues: { type: Schema.Types.Mixed },
    debtorId: { type: Schema.Types.ObjectId, ref: 'debtor' },
    clientId: { type: Schema.Types.ObjectId, ref: 'client' },
    month: { type: Schema.Types.String },
    year: { type: Schema.Types.String },
    currentStepIndex: {
      type: Schema.Types.String,
      enum: ['GENERATED', 'VALIDATED', 'PROCESSED'],
      default: 'GENERATED',
    },
  },
  { timestamps: true },
);

/**
 * Export Schema
 */
module.exports = mongoose.model('import-overdue-dump', importOverdueDumpSchema);
